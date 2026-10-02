// End-to-end: one real server, one temp folder + state DB per simulated Mac, real FSEvents.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { startServer } from '../server/server.ts'
import { LocalState, type Project } from '../client-core/state.ts'
import { ProjectSync, call, createProject, joinProject, runsCode } from '../client-core/engine.ts'
import { sha256 } from '../shared/protocol.ts'
import { restore } from '../client-core/hub.ts'

const FAST = { liveMs: 80, calmMs: 1000, reconnectMaxMs: 300 }
const NAMES = ['Giles', 'Oliver', 'Ada', 'Lin']
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

interface Mac {
  root: string
  state: LocalState
  p: Project
  sync: ProjectSync
}

async function until(what: string, cond: () => boolean, ms = 10_000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(25)
  }
}

function write(root: string, files: Record<string, string | Buffer>) {
  for (const [path, data] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), data)
  }
}

function read(m: Mac, path: string) {
  try {
    return readFileSync(join(m.root, path), 'utf8')
  } catch {
    return null
  }
}

const bytes = (m: Mac, path: string) => (existsSync(join(m.root, path)) ? readFileSync(join(m.root, path)) : null)

function tree(root: string) {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.synchack') continue
      if (e.isDirectory()) walk(join(dir, e.name))
      else out.push(relative(root, join(dir, e.name)).normalize('NFC'))
    }
  }
  walk(root)
  return out.sort()
}

/** A server plus n Macs. Mac 0 shares a folder that already holds `files`; the rest join. */
async function team(n: number, files: Record<string, string | Buffer> = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'synchack-')))
  const dataDir = join(dir, 'server')
  let server = await startServer({ port: 0, dataDir })
  const macs: Mac[] = []
  for (let i = 0; i < n; i++) {
    const state = new LocalState(join(dir, `home-${i}`))
    state.setMeta('user', NAMES[i])
    const folder = join(dir, NAMES[i])
    let p: Project
    if (i === 0) {
      write(folder, files)
      p = await createProject(state, server.url, folder, 'demo')
    } else p = await joinProject(state, server.url, macs[0].p.code, folder)
    const sync = new ProjectSync(state, p, FAST).start()
    await sync.idle()
    macs.push({ root: p.root, state, p, sync })
  }
  return {
    macs,
    store: () => server.store,
    stopServer: () => server.close(),
    async startServer() {
      server = await startServer({ port: server.port, dataDir })
    },
    async close() {
      await Promise.all(macs.map(m => m.sync.stop()))
      await server.close().catch(() => {})
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const setModes = (macs: Mac[], mode: 'live' | 'paused') => macs.forEach(m => m.sync.setMode(mode))
const lines12 = Array.from({ length: 12 }, (_, i) => `line ${i}\n`).join('')

test('imports an existing folder; a teammate joins; edits flow both ways; ignores hold', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 255])
  const t = await team(2, {
    'package.json': '{ "name": "demo" }\n',
    'src/App.tsx': 'export const App = () => null\n',
    'src/components/deep/nested/Button.tsx': 'export const Button = 1\n',
    'docs/ré sumé 日本語.md': '# unicode\n',
    'my file with spaces.txt': 'spaces\n',
    'assets/logo.png': png,
    '.env': 'SECRET=giles\n',
    'node_modules/lib/index.js': 'module.exports = 1\n',
    'dist/bundle.js': '//\n',
    'npm-debug.log': 'noise\n',
    '.git/HEAD': 'ref: refs/heads/main\n',
  })
  try {
    const [a, b] = t.macs
    const shared = ['assets/logo.png', 'docs/ré sumé 日本語.md', 'my file with spaces.txt', 'package.json', 'src/App.tsx', 'src/components/deep/nested/Button.tsx']
    assert.deepEqual(tree(b.root), shared.map(s => s.normalize('NFC')).sort())
    assert.deepEqual(bytes(b, 'assets/logo.png'), png)

    write(a.root, { 'src/App.tsx': 'export const App = () => "v2"\n' })
    await until('B sees the edit', () => read(b, 'src/App.tsx') === 'export const App = () => "v2"\n')
    write(b.root, { 'backend/routes/form.ts': 'export {}\n' })
    await until('A sees a new file in new folders', () => read(a, 'backend/routes/form.ts') === 'export {}\n')

    write(b.root, { '.env': 'SECRET=oliver\n' }) // each Mac keeps its own secrets
    write(a.root, { '.synchackignore': 'scratch/\n!.env.example\n', '.env.example': 'SECRET=\n', 'scratch/notes.txt': 'mine\n' })
    await until('B gets the rules and .env.example (same round, either order)', () => read(b, '.env.example') === 'SECRET=\n' && read(b, '.synchackignore') === 'scratch/\n!.env.example\n')
    assert.equal(read(b, 'scratch/notes.txt'), null)
    assert.equal(read(a, '.env'), 'SECRET=giles\n')
    assert.equal(read(b, '.env'), 'SECRET=oliver\n')
  } finally {
    await t.close()
  }
})

test('creates, deletes, renames, folder moves and case-only renames propagate', async () => {
  const t = await team(2)
  try {
    const [a, b] = t.macs
    write(a.root, { 'old.ts': 'old\n', 'lib/one.ts': '1\n', 'lib/sub/two.ts': '2\n' })
    await until('B has the files', () => read(b, 'lib/sub/two.ts') === '2\n' && read(b, 'old.ts') === 'old\n')
    rmSync(join(a.root, 'old.ts'))
    await until('delete reaches B', () => read(b, 'old.ts') === null)
    renameSync(join(a.root, 'lib/one.ts'), join(a.root, 'lib/uno.ts'))
    await until('rename reaches B', () => read(b, 'lib/uno.ts') === '1\n' && read(b, 'lib/one.ts') === null)
    renameSync(join(a.root, 'lib'), join(a.root, 'src'))
    await until('folder move reaches B', () => read(b, 'src/sub/two.ts') === '2\n' && read(b, 'src/uno.ts') === '1\n' && !existsSync(join(b.root, 'lib')))
    renameSync(join(a.root, 'src/uno.ts'), join(a.root, 'src/Uno.ts'))
    await until('case-only rename reaches B', () => readdirSync(join(b.root, 'src')).includes('Uno.ts') && !readdirSync(join(b.root, 'src')).includes('uno.ts'))
    rmSync(join(b.root, 'src'), { recursive: true })
    await until('folder delete reaches A', () => !existsSync(join(a.root, 'src')))
    assert.deepEqual(tree(a.root), tree(b.root))
  } finally {
    await t.close()
  }
})

test('rapid save bursts upload settled content only; remote writes never echo back', async () => {
  const t = await team(2)
  try {
    const [a, b] = t.macs
    for (let i = 0; i <= 40; i++) {
      write(a.root, { 'burst.txt': `save ${i}\n` })
      await sleep(5)
    }
    await until('B has the last save', () => read(b, 'burst.txt') === 'save 40\n')
    await sleep(500)
    const versions = t.store().history(a.p.id, 'burst.txt').length
    assert.ok(versions <= 5, `${versions} versions for one burst`)
    assert.equal(b.sync.stats.ops, 0, 'B only received; it must not upload its own writes')
  } finally {
    await t.close()
  }
})

test('concurrent edits to different lines of one file merge automatically', async () => {
  const t = await team(3)
  try {
    const [a, b, c] = t.macs
    write(a.root, { 'shared.ts': lines12 })
    await until('all have the base', () => t.macs.every(m => read(m, 'shared.ts') === lines12))
    setModes([a, b], 'paused')
    write(a.root, { 'shared.ts': lines12.replace('line 1\n', 'line 1 by A\n') })
    write(b.root, { 'shared.ts': lines12.replace('line 9\n', 'line 9 by B\n') })
    await sleep(200)
    setModes([a, b], 'live')
    let want = lines12.replace('line 1\n', 'line 1 by A\n').replace('line 9\n', 'line 9 by B\n')
    await until('everyone converges on the merge', () => t.macs.every(m => read(m, 'shared.ts') === want))

    // all three live, writing in the same instant: no pause trick, just the race
    const edits: [Mac, string][] = [[a, 'line 3'], [b, 'line 6'], [c, 'line 11']]
    for (const [m, line] of edits) write(m.root, { 'shared.ts': want.replace(`${line}\n`, `${line} live\n`) })
    for (const [, line] of edits) want = want.replace(`${line}\n`, `${line} live\n`)
    await until('three-way live race merges', () => t.macs.every(m => read(m, 'shared.ts') === want))
    assert.ok(t.macs.every(m => m.sync.conflicts.size === 0))
  } finally {
    await t.close()
  }
})

test('a file replaced by a folder of the same name syncs both ways', async () => {
  const t = await team(2)
  try {
    const [a, b] = t.macs
    write(a.root, { config: 'single file\n' })
    await until('B has the file', () => read(b, 'config') === 'single file\n')
    rmSync(join(a.root, 'config'))
    write(a.root, { 'config/app.json': '{}\n' })
    await until('B has the folder', () => read(b, 'config/app.json') === '{}\n')
    rmSync(join(b.root, 'config'), { recursive: true })
    write(b.root, { config: 'a file again\n' })
    await until('A has the file again', () => read(a, 'config') === 'a file again\n')
    assert.deepEqual(tree(a.root), tree(b.root))
  } finally {
    await t.close()
  }
})

test('overlapping edits conflict: nothing lost, all notified, votes, resolution', async () => {
  const t = await team(3)
  try {
    const [a, b, c] = t.macs
    const base = 'title = "base"\nbody\n', verA = 'title = "Giles"\nbody\n', verB = 'title = "Oliver"\nbody\n'
    write(a.root, { 'App.tsx': base })
    await until('all have the base', () => t.macs.every(m => read(m, 'App.tsx') === base))
    setModes([a, b], 'paused')
    write(a.root, { 'App.tsx': verA })
    write(b.root, { 'App.tsx': verB })
    await sleep(200)
    setModes([a, b], 'live')
    await until('everyone is notified', () => t.macs.every(m => m.sync.conflicts.size === 1))

    const [conflict] = c.sync.conflicts.values()
    const text = (h: string | null) => (h ? t.store().readBlob(a.p.id, h).toString() : null)
    assert.deepEqual([text(conflict.a.hash), text(conflict.b.hash)].sort(), [verA, verB].sort(), 'both candidates kept')
    assert.equal(read(a, 'App.tsx'), verA, "Giles's work untouched")
    assert.equal(read(b, 'App.tsx'), verB, "Oliver's work untouched")

    write(b.root, { 'other.ts': 'still syncing\n' })
    await until('other files keep syncing', () => read(a, 'other.ts') === 'still syncing\n')

    await call(a.p, 'POST', `/conflicts/${conflict.id}/vote`, { choice: 'B' })
    await call(c.p, 'POST', `/conflicts/${conflict.id}/vote`, { choice: 'B' })
    await until('votes reach everyone', () => Object.keys(b.sync.conflicts.get(conflict.id)?.votes ?? {}).length === 2)
    const winner = text(conflict.b.hash)
    await call(c.p, 'POST', `/conflicts/${conflict.id}/resolve`, { choice: 'B' })
    await until('resolution lands everywhere', () => t.macs.every(m => read(m, 'App.tsx') === winner && m.sync.conflicts.size === 0))

    write(a.root, { 'App.tsx': 'after\n' })
    await until('the file syncs normally again', () => read(b, 'App.tsx') === 'after\n' && read(c, 'App.tsx') === 'after\n')
  } finally {
    await t.close()
  }
})

test('deleting a file someone else edited is a conflict, not a silent loss', async () => {
  const t = await team(2)
  try {
    const [a, b] = t.macs
    write(a.root, { 'old.ts': 'v1\n' })
    await until('B has it', () => read(b, 'old.ts') === 'v1\n')
    setModes(t.macs, 'paused')
    write(a.root, { 'old.ts': 'v2 important work\n' })
    rmSync(join(b.root, 'old.ts'))
    await sleep(200)
    setModes(t.macs, 'live')
    await until('conflict on both', () => a.sync.conflicts.size === 1 && b.sync.conflicts.size === 1)
    const [c] = a.sync.conflicts.values()
    assert.deepEqual([c.a.hash === null, c.b.hash === null].sort(), [false, true], 'one candidate is the deletion')
    assert.equal(t.store().readBlob(a.p.id, (c.a.hash ?? c.b.hash)!).toString(), 'v2 important work\n')
    await call(b.p, 'POST', `/conflicts/${c.id}/resolve`, { choice: c.a.hash ? 'A' : 'B' })
    await until('the edit wins everywhere', () => read(a, 'old.ts') === 'v2 important work\n' && read(b, 'old.ts') === 'v2 important work\n')
  } finally {
    await t.close()
  }
})

test('same new path on two Macs: identical content is fine, different content conflicts', async () => {
  const t = await team(2)
  try {
    const [a, b] = t.macs
    setModes(t.macs, 'paused')
    write(a.root, { 'same.ts': 'export const x = 1\n', 'new.ts': 'from Giles\n' })
    write(b.root, { 'same.ts': 'export const x = 1\n', 'new.ts': 'from Oliver\n' })
    await sleep(200)
    setModes(t.macs, 'live')
    await until('one conflict', () => a.sync.conflicts.size === 1 && b.sync.conflicts.size === 1)
    const [c] = a.sync.conflicts.values()
    assert.equal(c.path, 'new.ts')
    const merged = Buffer.from('from Giles\nfrom Oliver\n') // hand-merged resolution
    await call(a.p, 'PUT', `/blobs/${sha256(merged)}`, merged)
    await call(a.p, 'POST', `/conflicts/${c.id}/resolve`, { hash: sha256(merged) })
    await until('manual merge everywhere', () => read(a, 'new.ts') === merged.toString() && read(b, 'new.ts') === merged.toString())
    assert.equal(read(b, 'same.ts'), 'export const x = 1\n')
  } finally {
    await t.close()
  }
})

test('binary files never text-merge: concurrent changes conflict, resolution is byte-exact', async () => {
  const t = await team(2)
  try {
    const [a, b] = t.macs
    const img = (n: number) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, n, 0, 255, n])
    write(a.root, { 'logo.png': img(1) })
    await until('B has the image', () => bytes(b, 'logo.png')?.equals(img(1)) === true)
    setModes(t.macs, 'paused')
    write(a.root, { 'logo.png': img(2) })
    write(b.root, { 'logo.png': img(3) })
    await sleep(200)
    setModes(t.macs, 'live')
    await until('conflict', () => a.sync.conflicts.size === 1 && b.sync.conflicts.size === 1)
    const [c] = b.sync.conflicts.values()
    const want = t.store().readBlob(a.p.id, c.a.hash!)
    await call(b.p, 'POST', `/conflicts/${c.id}/resolve`, { choice: 'A' })
    await until('byte-exact on both', () => bytes(a, 'logo.png')?.equals(want) === true && bytes(b, 'logo.png')?.equals(want) === true)
  } finally {
    await t.close()
  }
})

test('server outage: both edit offline, everything reconciles on reconnect', async () => {
  const t = await team(2)
  try {
    const [a, b] = t.macs
    write(a.root, { 'notes.md': lines12, 'gone.txt': 'bye\n' })
    await until('B has both', () => read(b, 'notes.md') === lines12 && read(b, 'gone.txt') === 'bye\n')
    await t.stopServer()
    await until('both offline', () => !a.sync.online && !b.sync.online)
    write(a.root, { 'notes.md': lines12.replace('line 1\n', 'line 1 offline A\n'), 'offline-a.txt': 'made offline\n' })
    write(b.root, { 'notes.md': lines12.replace('line 10\n', 'line 10 offline B\n') })
    rmSync(join(b.root, 'gone.txt'))
    await sleep(300)
    await t.startServer()
    const want = lines12.replace('line 1\n', 'line 1 offline A\n').replace('line 10\n', 'line 10 offline B\n')
    await until('reconciled', () => read(a, 'notes.md') === want && read(b, 'notes.md') === want && read(b, 'offline-a.txt') === 'made offline\n' && read(a, 'gone.txt') === null, 15_000)
    assert.deepEqual(tree(a.root), tree(b.root))
  } finally {
    await t.close()
  }
})

test('edits made while synchack was not running are picked up at start', async () => {
  const t = await team(2)
  try {
    const [a, b] = t.macs
    await a.sync.stop()
    write(a.root, { 'while-stopped.txt': 'hi\n' })
    a.sync = new ProjectSync(a.state, a.state.project(a.p.id)!, FAST).start()
    await until('B gets it', () => read(b, 'while-stopped.txt') === 'hi\n')
  } finally {
    await t.close()
  }
})

test('duplicate, stale and hostile events are harmless', async () => {
  const t = await team(2)
  try {
    const [a, b] = t.macs
    const sync = b.sync as any // drive the private receive path through the same serial queue
    const inject = async (msg: object) => {
      sync.enqueue(() => sync.receive(sync.ws, msg))
      await sync.settled()
    }
    write(a.root, { 'dup.txt': 'one\n' })
    await until('B has one', () => read(b, 'dup.txt') === 'one\n')
    const first = t.store().head(a.p.id, 'dup.txt')
    write(a.root, { 'dup.txt': 'two\n' })
    await until('B has two', () => read(b, 'dup.txt') === 'two\n')
    const second = t.store().head(a.p.id, 'dup.txt')
    for (const head of [second, second, first, first]) await inject({ type: 'change', head })
    assert.equal(read(b, 'dup.txt'), 'two\n')

    const evil = Buffer.from('pwned\n')
    await call(a.p, 'PUT', `/blobs/${sha256(evil)}`, evil)
    const outside = join(dirname(b.root), 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(b.root, 'link'))
    for (const path of ['../escape.txt', '/tmp/abs.txt', 'link/x.txt', '.git/hooks/pre-commit'])
      await inject({ type: 'change', head: { path, version: 99, hash: sha256(evil), seq: 0, device: null, author: 'evil', at: 0 } })
    assert.ok(!existsSync(join(dirname(b.root), 'escape.txt')))
    assert.deepEqual(readdirSync(outside), [])
    assert.ok(!existsSync(join(b.root, '.git')))
    const { results } = await call(a.p, 'POST', '/ops', { ops: [{ opId: 'x', path: '../escape.txt', baseVersion: 0, baseHash: null, hash: sha256(evil) }] })
    assert.equal(results[0].status, 'error')
    assert.equal(b.sync.stats.ops, 0)
  } finally {
    await t.close()
  }
})

test('paused holds changes both ways and reconciles on resume; calm batches uploads', async () => {
  const t = await team(2)
  try {
    const [a, b] = t.macs
    a.sync.setMode('paused')
    write(a.root, { 'p.txt': 'made while paused\n' })
    write(b.root, { 'q.txt': 'from live B\n' })
    await sleep(600)
    assert.equal(read(b, 'p.txt'), null)
    assert.equal(read(a, 'q.txt'), null)
    a.sync.setMode('live')
    await until('both directions catch up', () => read(b, 'p.txt') === 'made while paused\n' && read(a, 'q.txt') === 'from live B\n')

    a.sync.setMode('calm') // calmMs is 1 s in these tests
    write(a.root, { 'calm.txt': 'later\n' })
    await sleep(500)
    assert.equal(read(b, 'calm.txt'), null, 'calm mode waits')
    await until('calm upload lands', () => read(b, 'calm.txt') === 'later\n')
  } finally {
    await t.close()
  }
})

test('1500 files in nested folders import and join intact', async () => {
  const files: Record<string, string> = {}
  for (let i = 0; i < 1500; i++) files[`pkg${i % 15}/mod${i % 7}/file-${i}.ts`] = `export const n${i} = ${i}\n`
  const t0 = Date.now()
  const t = await team(2, files)
  try {
    const [a, b] = t.macs
    assert.equal(tree(b.root).length, 1500)
    assert.deepEqual(tree(b.root), tree(a.root))
    for (const [path, body] of Object.entries(files)) assert.equal(read(b, path), body)
    console.log(`# 1500 files: import + join in ${Date.now() - t0} ms`)
  } finally {
    await t.close()
  }
})

test('mass deletions pause sync until confirmed; restore brings files back; moves are not deletions', async () => {
  const files = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`src/f${i}.ts`, `export const n = ${i}\n`]))
  const t = await team(2, files)
  const [a, b] = t.macs
  try {
    // Moving a big folder is 60 deletions plus 60 creations of the same content: not a mass delete.
    renameSync(join(a.root, 'src'), join(a.root, 'lib'))
    await until('B sees the move', () => read(b, 'lib/f59.ts') !== null && read(b, 'src/f0.ts') === null)
    assert.equal(a.sync.mode, 'live')

    rmSync(join(a.root, 'lib'), { recursive: true })
    await until('A pauses', () => a.sync.mode === 'paused')
    await sleep(300)
    assert.equal(read(b, 'lib/f0.ts'), 'export const n = 0\n', 'nothing was deleted on B')

    const restored = await restore(a.p, 'lib')
    assert.equal(restored.length, 60)
    a.sync.setMode('live')
    await a.sync.idle()
    await sleep(300)
    assert.equal(tree(b.root).length, 60, 'B still has every file')

    // Confirming by resuming sends the deletions.
    rmSync(join(a.root, 'lib'), { recursive: true })
    await until('A pauses again', () => a.sync.mode === 'paused')
    a.sync.setMode('live')
    await until('B loses the files', () => tree(b.root).length === 0)
  } finally {
    await t.close()
  }
})

test('restore: any old version of a file, and a file deleted everywhere', async () => {
  const t = await team(2, { 'notes.md': 'v1\n' })
  const [a, b] = t.macs
  try {
    write(a.root, { 'notes.md': 'v2\n' })
    await until('B has v2', () => read(b, 'notes.md') === 'v2\n')
    await assert.rejects(restore(b.p, 'notes.md', { version: 1 }), /--force/)
    await restore(b.p, 'notes.md', { version: 1, force: true })
    await until('A gets v1 back', () => read(a, 'notes.md') === 'v1\n')

    rmSync(join(a.root, 'notes.md'))
    await until('B loses it', () => read(b, 'notes.md') === null)
    assert.deepEqual(await restore(b.p), ['notes.md'])
    assert.equal(read(b, 'notes.md'), 'v1\n')
    await until('A gets it back', () => read(a, 'notes.md') === 'v1\n')
  } finally {
    await t.close()
  }
})

test('changes to files that tools execute are flagged on arrival', async () => {
  assert.ok(runsCode('.claude/settings.json') && runsCode('web/package.json') && runsCode('.github/workflows/ci.yml'))
  assert.ok(!runsCode('src/package.json.bak') && !runsCode('docs/claude-notes.md'))
  // APFS ignores case: docs/claude.md is the docs/CLAUDE.md agents read, .CLAUDE/ is .claude/
  assert.ok(runsCode('docs/claude.md') && runsCode('.CLAUDE/settings.json'))
  const t = await team(2)
  const [a, b] = t.macs
  const logs: string[] = []
  b.sync.on('log', (l: string) => logs.push(l))
  try {
    write(a.root, { '.claude/settings.json': '{"hooks":{}}\n', 'src/app.ts': 'x\n' })
    await until('B has both', () => read(b, 'src/app.ts') !== null && read(b, '.claude/settings.json') !== null)
    assert.deepEqual(logs.filter(l => l.startsWith('⚠')).map(l => l.split(' ')[1]), ['.claude/settings.json'])
  } finally {
    await t.close()
  }
})
