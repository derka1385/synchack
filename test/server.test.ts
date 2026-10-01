// Server API: authentication, invites, membership and limits, without any client engine.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer, type ServerOptions } from '../server/server.ts'
import { INVITE_TTL, MAX_MERGE_LINES } from '../server/store.ts'
import { lanAddresses, sha256 } from '../shared/protocol.ts'

async function server(opts: ServerOptions = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'synchack-server-'))
  const s = await startServer({ port: 0, dataDir, ...opts })
  const api = async (method: string, path: string, body?: unknown, token?: string, base = s.url) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  const me = (device: string, user = device) => ({ device, user, deviceName: 'Mac' })
  return {
    s,
    api,
    me,
    create: async (device = 'alice') => (await api('POST', '/api/projects', { name: 'demo', ...me(device) })).body,
    async close() {
      await s.close()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

test("joining with a teammate's device id cannot take over their identity", async t => {
  const x = await server()
  t.after(() => x.close())
  const alice = await x.create('alice')
  const takeover = await x.api('POST', '/api/join', { code: alice.code, ...x.me('alice', 'Mallory') })
  assert.equal(takeover.status, 409)
  assert.equal((await x.api('GET', `/api/p/${alice.projectId}/heads`, undefined, alice.token)).status, 200, 'Alice keeps working')
  const { members } = (await x.api('GET', `/api/p/${alice.projectId}/members`, undefined, alice.token)).body
  assert.deepEqual(members.map((m: { name: string }) => m.name), ['alice'])
  // The device itself may rejoin when it proves who it is, e.g. after reinstalling.
  const again = await x.api('POST', '/api/join', { code: alice.code, ...x.me('alice') }, alice.token)
  assert.equal(again.status, 200)
})

test('invites expire, can be replaced, and members are unaffected', async t => {
  const x = await server()
  t.after(() => x.close())
  const alice = await x.create()
  const bob = (await x.api('POST', '/api/join', { code: alice.code, ...x.me('bob') })).body
  const p = `/api/p/${alice.projectId}`
  const same = (await x.api('POST', `${p}/invite`, {}, bob.token)).body
  assert.equal(same.code, alice.code)
  assert.ok(same.expires > Date.now() + INVITE_TTL - 60_000)

  const fresh = (await x.api('POST', `${p}/invite`, { rotate: true }, bob.token)).body
  assert.notEqual(fresh.code, alice.code)
  assert.equal((await x.api('POST', '/api/join', { code: alice.code, ...x.me('carol') })).status, 404, 'old code is dead')
  assert.equal((await x.api('POST', '/api/join', { code: fresh.code, ...x.me('carol') })).status, 200)

  x.s.store.db.prepare('update projects set code_expires = ?').run(Date.now() - 1)
  assert.equal((await x.api('POST', '/api/join', { code: fresh.code, ...x.me('dan') })).status, 404, 'expired')
  assert.equal((await x.api('GET', `${p}/heads`, undefined, bob.token)).status, 200, 'members keep access')
  const renewed = (await x.api('POST', `${p}/invite`, {}, alice.token)).body
  assert.notEqual(renewed.code, fresh.code, 'an expired code is replaced, never revived')
})

test('the creator removes a teammate: token, socket and invite all stop working', async t => {
  const x = await server()
  t.after(() => x.close())
  const alice = await x.create()
  const bob = (await x.api('POST', '/api/join', { code: alice.code, ...x.me('bob') })).body
  const carol = (await x.api('POST', '/api/join', { code: alice.code, ...x.me('carol') })).body
  const p = `/api/p/${alice.projectId}`
  assert.equal((await x.api('DELETE', `${p}/members/carol`, undefined, bob.token)).status, 403, 'only the creator removes others')

  const ws = new WebSocket(`${x.s.url.replace('http', 'ws')}${p}/ws?token=${bob.token}`)
  const closed = new Promise<number>(ok => (ws.onclose = e => ok(e.code)))
  await new Promise(ok => (ws.onopen = ok))
  const r = await x.api('DELETE', `${p}/members/bob`, undefined, alice.token)
  assert.equal(r.status, 200)
  assert.equal(await closed, 4001)
  assert.notEqual(r.body.invite.code, alice.code, 'removing someone replaces the invite')
  assert.equal((await x.api('GET', `${p}/heads`, undefined, bob.token)).status, 401)
  assert.equal((await x.api('POST', '/api/join', { code: alice.code, ...x.me('bob') })).status, 404)

  assert.equal((await x.api('DELETE', `${p}/members/carol`, undefined, carol.token)).status, 200, 'anyone can leave')
  assert.equal((await x.api('GET', `${p}/heads`, undefined, carol.token)).status, 401)
})

test('join and create attempts are rate limited per address', async t => {
  const x = await server({ rateLimit: { max: 5, windowMs: 60_000, limitLoopback: true } })
  t.after(() => x.close())
  const alice = await x.create()
  for (let i = 0; i < 4; i++) assert.equal((await x.api('POST', '/api/join', { code: 'AAA-AAA', ...x.me(`g${i}`) })).status, 404)
  const blocked = await x.api('POST', '/api/join', { code: alice.code, ...x.me('late') })
  assert.equal(blocked.status, 429, 'even a right guess is refused once over the limit')
  assert.equal((await x.api('POST', '/api/projects', { name: 'x', ...x.me('z') })).status, 429)
})

test('a hosting Mac only creates projects for itself', async t => {
  const x = await server({ localCreateOnly: true })
  t.after(() => x.close())
  assert.equal((await x.api('POST', '/api/projects', { name: 'mine', ...x.me('alice') })).status, 200)
  const ip = lanAddresses()[0]
  if (!ip) return t.skip('no network address to call from')
  const remote = await x.api('POST', '/api/projects', { name: 'theirs', ...x.me('eve') }, undefined, `http://${ip}:${x.s.port}`)
  assert.equal(remote.status, 403)
})

/** Uploads `files` as v1 of each path, then returns a helper that sends ops against base v1. */
async function seeded(x: Awaited<ReturnType<typeof server>>, files: Record<string, string>) {
  const alice = await x.create()
  const p = `/api/p/${alice.projectId}`
  const put = async (text: string) => {
    const bytes = Buffer.from(text)
    const hash = sha256(bytes)
    const r = await fetch(`${x.s.url}${p}/blobs/${hash}`, { method: 'PUT', headers: { authorization: `Bearer ${alice.token}` }, body: new Uint8Array(bytes) })
    assert.equal(r.status, 204)
    return hash
  }
  const ops = async (list: { path: string; base: string | null; text: string }[]) => {
    const body = { ops: await Promise.all(list.map(async (o, i) => ({ opId: `${o.path}-${i}-${Math.random()}`, path: o.path, baseVersion: 0, baseHash: o.base, hash: await put(o.text) }))) }
    return (await x.api('POST', `${p}/ops`, body, alice.token)).body.results as { status: string }[]
  }
  const bases: Record<string, string> = {}
  for (const [path, text] of Object.entries(files)) {
    bases[path] = await put(text)
    assert.equal((await ops([{ path, base: null, text }]))[0].status, 'ok')
  }
  return { alice, p, put, ops, bases }
}

const numbered = (n: number, tag = '', every = 0) => Array.from({ length: n }, (_, i) => (every && i % every === 0 ? `${tag}${i}\n` : `line ${i}\n`)).join('')

test('server merges are rationed: one request cannot monopolise the server', async t => {
  const x = await server()
  t.after(() => x.close())
  const { ops, bases, alice } = await seeded(x, { 'a.txt': numbered(50) })
  // Move the head on, then send a change against the old base: it needs a merge.
  await ops([{ path: 'a.txt', base: bases['a.txt'], text: numbered(50).replace('line 1\n', 'one\n') }])
  ;(x.s.store as unknown as { mergeDebt: number }).mergeDebt = 60_000 // as if it had just merged for a minute
  const [busy] = await ops([{ path: 'a.txt', base: bases['a.txt'], text: numbered(50).replace('line 40\n', 'forty\n') }])
  assert.equal(busy.status, 'busy')
  ;(x.s.store as unknown as { mergeDebt: number }).mergeDebt = 0
  const [merged] = await ops([{ path: 'a.txt', base: bases['a.txt'], text: numbered(50).replace('line 40\n', 'forty\n') }])
  assert.equal(merged.status, 'merged', 'the same change goes through once the server has time')
  assert.ok(alice)
})

test('texts too long to merge cheaply become conflicts instead of stalling the server', async t => {
  const x = await server()
  t.after(() => x.close())
  const big = numbered(MAX_MERGE_LINES / 2)
  const { ops, bases } = await seeded(x, { 'big.txt': big })
  await ops([{ path: 'big.txt', base: bases['big.txt'], text: big.replace('line 1\n', 'one\n') }])
  const start = Date.now()
  const [r] = await ops([{ path: 'big.txt', base: bases['big.txt'], text: big.replace('line 9000\n', 'nine thousand\n') }])
  assert.equal(r.status, 'conflict')
  assert.ok(Date.now() - start < 2000, `took ${Date.now() - start} ms`)
})

test('uploads: hash checked while streaming, quota enforced, nothing left behind', async t => {
  const x = await server({ quota: 1000 })
  t.after(() => x.close())
  const alice = await x.create()
  const p = `${x.s.url}/api/p/${alice.projectId}`
  const put = (hash: string, body: Buffer) => fetch(`${p}/blobs/${hash}`, { method: 'PUT', headers: { authorization: `Bearer ${alice.token}` }, body: new Uint8Array(body) })
  const small = Buffer.from('hello')
  assert.equal((await put(sha256(Buffer.from('other')), small)).status, 400)
  assert.equal((await put(sha256(small), small)).status, 204)
  assert.equal((await put(sha256(small), small)).status, 204, 'an existing blob is accepted again')
  const big = Buffer.alloc(2000, 1)
  assert.equal((await put(sha256(big), big)).status, 507)
  assert.deepEqual(readdirSync(join(x.s.store.dir, 'blobs', 'tmp')), [], 'no temp files left over')
})

test('WebSocket messages from clients are capped', async t => {
  const x = await server()
  t.after(() => x.close())
  const alice = await x.create()
  const ws = new WebSocket(`${x.s.url.replace('http', 'ws')}/api/p/${alice.projectId}/ws?token=${alice.token}`)
  const closed = new Promise<number>(ok => (ws.onclose = e => ok(e.code)))
  await new Promise(ok => (ws.onopen = ok))
  ws.send('x'.repeat(100_000))
  assert.equal(await closed, 1009)
})
