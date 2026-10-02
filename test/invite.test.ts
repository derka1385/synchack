// Inviting someone from the Nearby list: Bonjour lookup, TLS-pinned delivery, code check, join.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalState } from '../client-core/state.ts'
import { Hub, addFile, listFiles, setShared } from '../client-core/hub.ts'

const FAST = { liveMs: 80, calmMs: 1000, reconnectMaxMs: 300 }

async function until(what: string, cond: () => boolean, ms = 10_000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await new Promise(r => setTimeout(r, 25))
  }
}

test('invite a nearby teammate: they join with the code on your screen, never with a wrong or forged one', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'synchack-inv-')))
  const hub = (i: number, user: string) => {
    const state = new LocalState(join(dir, `home-${i}`))
    state.setMeta('user', user)
    return new Hub(state, { port: 0, sync: FAST }).start()
  }
  const giles = await hub(0, 'Giles')
  const oliver = await hub(1, 'Oliver')
  try {
    mkdirSync(join(dir, 'orvect'))
    writeFileSync(join(dir, 'orvect', 'api.py'), 'app = 1\n')
    const p = await giles.create(join(dir, 'orvect'))
    await until('Giles sees Oliver nearby', () => giles.nearby.has(oliver.me))

    const code = await giles.invite(p.id, oliver.me)
    await until('the invitation reaches Oliver', () => oliver.inbox.length === 1)
    const [inv] = oliver.inbox
    assert.equal(inv.project, 'orvect')
    assert.match(inv.from, /^Giles/)

    await assert.rejects(oliver.accept(inv.id, 'ZZZ-ZZZ'), /wrong code/)
    // someone on the Wi-Fi forging an invitation to their own server gets nowhere without the code
    const forged = { ...inv, address: '10.6.6.6:8787' }
    oliver.inbox.push({ ...forged, id: 'forged' })
    await assert.rejects(oliver.accept('forged', code), /wrong code/)

    const q = await oliver.accept(inv.id, code.toLowerCase().replace('-', ''), join(dir, 'oliver-copy')) // typed loosely
    assert.equal(q.name, 'orvect')
    await until('the files arrive', () => existsSync(join(q.root, 'api.py')))
    assert.equal(oliver.inbox.some(i => i.id === inv.id), false)
  } finally {
    await Promise.all([giles.close(), oliver.close()])
    rmSync(dir, { recursive: true, force: true })
  }
})

test('share toggles write .synchackignore; secrets can never be shared; new files land in the folder', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'synchack-files-')))
  try {
    mkdirSync(join(root, 'backend/.venv'), { recursive: true })
    mkdirSync(join(root, 'docs'))
    writeFileSync(join(root, '.env'), 'KEY=1\n')
    writeFileSync(join(root, 'app.db'), 'x')
    const shared = (path: string) => listFiles(root, path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '').find(e => e.path === path)?.shared
    assert.equal(shared('docs'), true)
    setShared(root, 'docs', true, false)
    assert.equal(shared('docs'), false)
    setShared(root, 'app.db', false, true) // re-include a default-ignored file
    assert.equal(shared('app.db'), true)
    setShared(root, 'docs', true, true)
    assert.equal(shared('docs'), true)
    assert.equal(readFileSync(join(root, '.synchackignore'), 'utf8'), '!/app.db\n')
    assert.throws(() => setShared(root, '.env', false, true), /secrets/)
    assert.throws(() => setShared(root, 'backend/.venv/x', false, true), /inside a folder/)
    assert.equal(addFile(root, 'notes/todo.md', '# todo\n'), 'notes/todo.md')
    assert.equal(readFileSync(join(root, 'notes/todo.md'), 'utf8'), '# todo\n')
    assert.throws(() => addFile(root, 'notes/todo.md'), /already exists/)
    assert.throws(() => addFile(root, '../escape.txt'), /invalid path/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
