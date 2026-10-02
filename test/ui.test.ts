// The browser app's local API: locked to this Mac and this launch, and doing what the page asks.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalState } from '../client-core/state.ts'
import { Hub } from '../client-core/hub.ts'
import { startUi } from '../client-core/ui-server.ts'

const raw = (address: string, path: string, headers: Record<string, string>) =>
  new Promise<number>((ok, fail) => {
    const [host, port] = address.split(':')
    request({ host, port, path, method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, res => (res.resume(), ok(res.statusCode ?? 0))).on('error', fail).end('{}')
  })

test('browser app API: token and Host checks, create with preview, files, sharing toggles, new files, live state', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'synchack-web-')))
  const state = new LocalState(join(dir, 'home'))
  state.setMeta('user', 'Nolann')
  const hub = await new Hub(state, { port: 0, discover: false, sync: { liveMs: 80 } }).start()
  const ui = await startUi(hub)
  const api = async (action: string, body: object = {}) => {
    const r = await fetch(`http://${ui.address}/api/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-token': ui.token }, body: JSON.stringify(body) })
    const j = await r.json()
    if (!r.ok) throw new Error(j.error)
    return j
  }
  try {
    assert.equal((await fetch(`http://${ui.address}/`)).status, 200, 'the page itself is public')
    assert.equal(await raw(ui.address, '/api/preview', {}), 403, 'no token')
    assert.equal(await raw(ui.address, '/api/preview', { 'x-token': ui.token, host: `evil.example:${ui.address.split(':')[1]}` }), 403, 'DNS rebinding')

    const proj = join(dir, 'orvect')
    mkdirSync(join(proj, 'backend/.venv'), { recursive: true })
    writeFileSync(join(proj, 'main.py'), 'app = 1\n')
    writeFileSync(join(proj, '.env'), 'KEY=1\n')
    const preview = await api('preview', { dir: proj })
    assert.equal(preview.exists, true)
    assert.match(preview.lines[0][1], /^1 file \(/)
    assert.ok(preview.entries.find((e: { name: string; secret: boolean }) => e.name === '.env').secret)

    const created = await api('create', { dir: proj, invite: [] })
    assert.equal(created.name, 'orvect')
    await hub.engines.get(created.id)!.idle()

    const files = await api('files', { project: created.id })
    assert.deepEqual(files.map((f: { name: string; shared: boolean }) => [f.name, f.shared]), [['backend', true], ['.env', false], ['main.py', true]])
    await api('share', { project: created.id, path: 'main.py', dir: false, shared: false })
    assert.equal(readFileSync(join(proj, '.synchackignore'), 'utf8'), '/main.py\n')
    await assert.rejects(api('share', { project: created.id, path: '.env', dir: false, shared: true }), /secrets/)

    await api('newFile', { project: created.id, path: 'notes/plan.md', content: '# plan\n' })
    assert.equal(readFileSync(join(proj, 'notes/plan.md'), 'utf8'), '# plan\n')
    await api('upload', { project: created.id, path: 'logo.png', data: Buffer.from([0x89, 0x50, 0, 1]).toString('base64') })
    assert.ok(existsSync(join(proj, 'logo.png')))
    await assert.rejects(api('newFile', { project: created.id, path: '../escape.md' }), /invalid path/)

    // the page's live feed: one snapshot right away
    const res = await fetch(`http://${ui.address}/api/events?t=${ui.token}`)
    const reader = res.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    await reader.cancel()
    const snap = JSON.parse(first.replace(/^data: /, ''))
    assert.equal(snap.me.user, 'Nolann')
    assert.equal(snap.projects[0].name, 'orvect')
    assert.equal(snap.projects[0].members[0].you, true)
  } finally {
    await ui.close()
    await hub.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('version history: see every version, what restoring changes, restore it (as a new version), recover deleted files', async () => {
  const { lineDiff } = await import('../client-core/ui-server.ts')
  const ten = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n') + '\n'
  assert.deepEqual(lineDiff(ten, ten.replace('line 5', 'line five')).map(r => r.t).join(''), '…===-+===…')
  assert.deepEqual(lineDiff('', 'a\n'), [{ t: '+', s: 'a' }])

  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'synchack-hist-')))
  const state = new LocalState(join(dir, 'home'))
  const hub = await new Hub(state, { port: 0, discover: false, sync: { liveMs: 60 } }).start()
  const ui = await startUi(hub)
  const api = async (action: string, body: object = {}) => {
    const r = await fetch(`http://${ui.address}/api/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-token': ui.token }, body: JSON.stringify(body) })
    const j = await r.json()
    if (!r.ok) throw new Error(j.error)
    return j
  }
  try {
    const proj = join(dir, 'app')
    mkdirSync(proj)
    writeFileSync(join(proj, 'api.py'), 'v1\n')
    writeFileSync(join(proj, 'old.py'), 'keep me\n')
    const { id } = await api('create', { dir: proj, invite: [] })
    const sync = hub.engines.get(id)!
    await sync.idle()
    for (const body of ['v2\n', 'v3 broken\n']) {
      writeFileSync(join(proj, 'api.py'), body)
      await new Promise(r => setTimeout(r, 150))
      await sync.idle()
    }
    const { versions } = await api('history', { project: id, path: 'api.py' })
    assert.deepEqual(versions.map((v: { version: number }) => v.version), [3, 2, 1], 'newest first')

    const v1 = await api('version', { project: id, path: 'api.py', version: 1 })
    assert.deepEqual(v1.diff, [{ t: '-', s: 'v3 broken' }, { t: '+', s: 'v1' }])
    await api('restoreVersion', { project: id, path: 'api.py', version: 1 })
    assert.equal(readFileSync(join(proj, 'api.py'), 'utf8'), 'v1\n')
    await new Promise(r => setTimeout(r, 150))
    await sync.idle()
    const after = await api('history', { project: id, path: 'api.py' })
    assert.equal(after.versions[0].version, 4, 'going back is a new version: v3 is still there to undo it')

    rmSync(join(proj, 'old.py'))
    await new Promise(r => setTimeout(r, 150))
    await sync.idle()
    const { files } = await api('deleted', { project: id })
    assert.deepEqual(files.map((f: { path: string }) => f.path), ['old.py'])
    await api('restoreDeleted', { project: id, path: 'old.py' })
    assert.equal(readFileSync(join(proj, 'old.py'), 'utf8'), 'keep me\n')
  } finally {
    await ui.close()
    await hub.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('new project picker: a typed path that does not exist lists where it will be created; home and system folders are refused', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'synchack-pick-')))
  const state = new LocalState(join(dir, 'home'))
  const hub = await new Hub(state, { port: 0, discover: false }).start()
  const ui = await startUi(hub)
  const api = async (action: string, body: object = {}) => {
    const r = await fetch(`http://${ui.address}/api/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-token': ui.token }, body: JSON.stringify(body) })
    const j = await r.json()
    if (!r.ok) throw new Error(j.error)
    return j
  }
  try {
    mkdirSync(join(dir, 'Coding', 'app'), { recursive: true })
    const typed = await api('browse', { dir: join(dir, 'Coding', 'brand-new', 'deeper') })
    assert.equal(typed.dir, join(dir, 'Coding'))
    assert.equal(typed.missing, join(dir, 'Coding', 'brand-new', 'deeper'))
    assert.deepEqual(typed.entries.map((e: { name: string }) => e.name), ['app'])
    assert.equal((await api('browse', { dir: join(dir, 'Coding') })).missing, undefined)
    writeFileSync(join(dir, 'Coding', 'file.txt'), 'x')
    await assert.rejects(api('browse', { dir: join(dir, 'Coding', 'file.txt') }), /is a file/)
    await assert.rejects(api('preview', { dir: '~' }), /can't share/)
    await assert.rejects(api('preview', { dir: '/Users' }), /can't share/)
  } finally {
    await ui.close()
    await hub.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
