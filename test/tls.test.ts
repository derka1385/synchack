// A Mac hosting over TLS: invites carry its key, joiners pin it, impostors learn nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../server/server.ts'
import { LocalState } from '../client-core/state.ts'
import { ProjectSync, createProject, joinProject } from '../client-core/engine.ts'
import { hostIdentity, request } from '../client-core/net.ts'
import { inviteFor, parseInvite } from '../client-core/hub.ts'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(what: string, cond: () => boolean, ms = 10_000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(25)
  }
}

test('pinned TLS: join by invite, sync both ways; a server with another key gets nothing', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'synchack-tls-')))
  const tls = hostIdentity(join(dir, 'tls'))
  if (!tls) return t.skip('no openssl to make a certificate')
  const host = await startServer({ port: 0, dataDir: join(dir, 'server'), tls })
  const lines: string[] = []
  const impostor = await startServer({ port: 0, dataDir: join(dir, 'impostor'), tls: hostIdentity(join(dir, 'tls2')), log: l => lines.push(l) })
  const syncs: ProjectSync[] = []
  t.after(async () => {
    await Promise.all(syncs.map(s => s.stop()))
    await host.close()
    await impostor.close()
    rmSync(dir, { recursive: true, force: true })
  })

  assert.equal((await request({ server: host.url }, 'GET', '/health').catch(e => e)).constructor.name, 'ConnectError', 'unpinned clients are refused')

  const a = new LocalState(join(dir, 'home-a'))
  const pa = await createProject(a, host.url, join(dir, 'A'), 'demo', host.cert)
  const invite = inviteFor(pa)
  const { code, pin } = parseInvite(invite)
  assert.ok(pin, `invite carries the key: ${invite}`)

  const b = new LocalState(join(dir, 'home-b'))
  const fake = `https://127.0.0.1:${impostor.port}`
  await assert.rejects(joinProject(b, fake, code, join(dir, 'B'), pin), /not the one in the invite/)
  await sleep(50)
  assert.deepEqual(lines.filter(l => l.includes('/api/join')), [], 'the impostor never saw the join code')

  const pb = await joinProject(b, `https://127.0.0.1:${host.port}`, code, join(dir, 'B'), pin)
  const fast = { liveMs: 80, calmMs: 1000, reconnectMaxMs: 300 }
  syncs.push(new ProjectSync(a, pa, fast).start(), new ProjectSync(b, pb, fast).start())
  await Promise.all(syncs.map(s => s.idle()))
  writeFileSync(join(pa.root, 'hello.txt'), 'over TLS\n')
  await until('B gets the file', () => {
    try {
      return readFileSync(join(pb.root, 'hello.txt'), 'utf8') === 'over TLS\n'
    } catch {
      return false
    }
  })
  writeFileSync(join(pb.root, 'back.txt'), 'and back\n')
  await until('A gets the reply', () => {
    try {
      return readFileSync(join(pa.root, 'back.txt'), 'utf8') === 'and back\n'
    } catch {
      return false
    }
  })

  const script = (await request({ server: host.url, cert: host.cert }, 'GET', '/install')).body.toString()
  assert.match(script, new RegExp(`--pinnedpubkey 'sha256//${host.pin!.replace(/[+/]/g, '\\$&')}'`))
})

test('invites: old plain ones still parse; pinned ones switch to https', () => {
  assert.deepEqual(parseInvite('HX7-K92@10.0.0.2:8787'), { code: 'HX7-K92', server: 'http://10.0.0.2:8787', pin: undefined })
  const pin = 'k3JqXk3JqXk3JqXk3JqXk3JqXk3JqXk3JqXk3JqXk3J'
  assert.deepEqual(parseInvite(`HX7-K92@10.0.0.2:8787#${pin}`), { code: 'HX7-K92', server: 'https://10.0.0.2:8787', pin })
})
