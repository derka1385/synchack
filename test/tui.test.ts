// The terminal UI and the hub behind it, driven like a user would.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render } from 'ink-testing-library'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalState } from '../client-core/state.ts'
import { BROWSE_LINE, Hub, inviteFor, parseInvite } from '../client-core/hub.ts'
import { App } from '../client-core/tui.ts'

const FAST = { liveMs: 80, calmMs: 1000, reconnectMaxMs: 300 }

async function until(what: string, cond: () => boolean, ms = 10_000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await new Promise(r => setTimeout(r, 25))
  }
}

test('invites carry the code and the address in one paste', () => {
  assert.deepEqual(parseInvite('HX7-K92@192.168.1.129:8787'), { code: 'HX7-K92', server: 'http://192.168.1.129:8787', pin: undefined })
  assert.deepEqual(parseInvite(' hx7k92@10.0.0.2 '), { code: 'hx7k92', server: 'http://10.0.0.2:8787', pin: undefined })
  assert.deepEqual(parseInvite('HX7-K92@https://abc.trycloudflare.com/'), { code: 'HX7-K92', server: 'https://abc.trycloudflare.com', pin: undefined })
  assert.throws(() => parseInvite('HX7-K92'))
  assert.equal(inviteFor({ code: 'HX7-K92', server: 'http://10.0.0.2:9000' }), 'HX7-K92@10.0.0.2:9000')
})

test('nearby Macs are read from dns-sd at any hour (before 10:00 the time starts with a space)', () => {
  for (const time of ['14:00:23.312', ' 8:26:54.006'])
    assert.deepEqual(`${time}  Add        3  14 local.               _synchack._tcp.      Oliver (MacBook-Air)`.match(BROWSE_LINE)?.slice(1), ['Add', '14', 'Oliver (MacBook-Air)'])
})

test('interface: share a folder, teammate joins by invite, see who edits which file, pause', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'synchack-ui-')))
  const hub = (i: number, user: string) => {
    const state = new LocalState(join(dir, `home-${i}`))
    state.setMeta('user', user)
    return new Hub(state, { port: 0, sync: FAST }).start()
  }
  const giles = await hub(0, 'Giles')
  const oliver = await hub(1, 'Oliver')
  const ui = render(React.createElement(App, { hub: giles }))
  const frame = () => ui.lastFrame() ?? ''
  try {
    await until('Giles sees Oliver available nearby (Bonjour)', () => /NEARBY[\s\S]*● Oliver/.test(frame()))
    mkdirSync(join(dir, 'HackHack'))
    writeFileSync(join(dir, 'HackHack', 'README.md'), 'hi\n')
    const p = await giles.create(join(dir, 'HackHack')) // the creator's folder name is the project name
    await until('project and invite on screen', () => frame().includes('HackHack') && frame().includes(`${p.code}@`)) // the long keyed invite may wrap

    const q = await oliver.join(inviteFor(p), join(dir, 'oliver'))
    assert.equal(q.name, 'HackHack')
    await until('Oliver has the files', () => existsSync(join(q.root, 'README.md')))
    await until('Oliver shows up online', () => /● Oliver/.test(frame()))

    writeFileSync(join(q.root, 'api.ts'), 'export {}\n')
    await until('Giles sees Oliver working on api.ts', () => /Oliver.*api\.ts/.test(frame()))
    await until('the activity log shows the download', () => frame().includes('↓ api.ts from Oliver'))

    // both edit the same file within minutes: heads-up before it becomes a conflict
    writeFileSync(join(p.root, 'api.ts'), 'export const a = 1\n')
    await until('heads-up about api.ts', () => /⚡ api\.ts/.test(frame()))

    ui.stdin.write('p')
    await until('paused on screen', () => frame().includes('paused'))
    assert.equal(giles.engines.get(p.id)?.mode, 'paused')
  } catch (e) {
    console.log(frame())
    throw e
  } finally {
    ui.unmount()
    await Promise.all([giles.close(), oliver.close()])
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sharing an existing project previews what stays on this Mac, then imports only the rest', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'synchack-ui-')))
  const state = new LocalState(join(dir, 'home'))
  const hub = await new Hub(state, { port: 0, sync: FAST, discover: false }).start()
  const ui = render(React.createElement(App, { hub }))
  const frame = () => ui.lastFrame() ?? ''
  const type = async (text: string) => {
    for (const ch of text) ui.stdin.write(ch), await new Promise(r => setTimeout(r, 2))
  }
  const proj = join(dir, 'orvect')
  for (const [path, body] of Object.entries({
    'backend/app/main.py': 'app = 1\n',
    'README.md': '# orvect\n',
    '.env': 'NEBIUS_KEY=secret\n',
    'backend/.venv/bin/python': 'binary\n',
    'backend/app/__pycache__/main.cpython-312.pyc': 'x',
    'backend/site.db': 'sqlite',
    '.git/HEAD': 'ref: refs/heads/main\n',
  })) {
    mkdirSync(join(proj, path, '..'), { recursive: true })
    writeFileSync(join(proj, path), body)
  }
  try {
    await type('n')
    await type('\x7f'.repeat(10)) // clear the ~/HackHack suggestion, one key at a time
    await type(proj)
    ui.stdin.write('\r')
    await until('preview on screen', () => frame().includes('Share orvect?'))
    const f = frame()
    assert.match(f, /2 files/)
    assert.match(f, /stays on this Mac: \.env/)
    assert.match(f, /not shared:.*\.venv\//)
    assert.match(f, /git repo/)
    assert.equal(hub.state.projects().length, 0, 'nothing shared before confirming')
    ui.stdin.write('\r')
    await until('shared after enter', () => hub.state.projects().length === 1)
    const p = hub.state.projects()[0]
    await hub.engines.get(p.id)!.idle()
    const onServer = hub.hosting!.store.heads(p.id).map(x => x.path).sort()
    assert.deepEqual(onServer, ['README.md', 'backend/app/main.py'])
  } catch (e) {
    console.log(frame())
    throw e
  } finally {
    ui.unmount()
    await hub.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('synchack stop ends a running synchack, and a pid left behind by a killed one (reused by macOS) is ignored', async () => {
  const { spawn, execFileSync } = await import('node:child_process')
  const { createServer } = await import('node:net')
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'synchack-stop-')))
  const port = await new Promise<number>(ok => { const s = createServer().listen(0, () => { const { port } = s.address() as { port: number }; s.close(() => ok(port)) }) })
  const env = { ...process.env, SYNCHACK_HOME: join(dir, 'home'), SYNCHACK_PORT: String(port), SYNCHACK_DISCOVER: '0' }
  const cli = (...args: string[]) => execFileSync(process.execPath, ['client-core/cli.ts', ...args], { env, encoding: 'utf8' })
  const other = spawn('sleep', ['30'])
  try {
    // a killed synchack left its pid, now used by some other process
    new LocalState(join(dir, 'home')).setMeta('daemon', String(other.pid))
    assert.match(cli('stop'), /not running/)
    const run = spawn(process.execPath, ['client-core/cli.ts', 'run'], { env })
    let out = ''
    run.stdout.on('data', d => (out += d))
    await until('synchack runs', () => out.includes('Ctrl-C to stop'))
    assert.match(cli('stop'), /Stopped synchack/)
    await until('it exited', () => run.exitCode !== null)
    assert.match(cli('status'), /No projects yet/)
  } finally {
    other.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})
