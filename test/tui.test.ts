// The terminal UI and the hub behind it, driven like a user would.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render } from 'ink-testing-library'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalState } from '../client-core/state.ts'
import { Hub, inviteFor, parseInvite } from '../client-core/hub.ts'
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
  assert.deepEqual(parseInvite('HX7-K92@192.168.1.129:8787'), { code: 'HX7-K92', server: 'http://192.168.1.129:8787' })
  assert.deepEqual(parseInvite(' hx7k92@10.0.0.2 '), { code: 'hx7k92', server: 'http://10.0.0.2:8787' })
  assert.deepEqual(parseInvite('HX7-K92@https://abc.trycloudflare.com/'), { code: 'HX7-K92', server: 'https://abc.trycloudflare.com' })
  assert.throws(() => parseInvite('HX7-K92'))
  assert.equal(inviteFor({ code: 'HX7-K92', server: 'http://10.0.0.2:9000' }), 'HX7-K92@10.0.0.2:9000')
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
    await until('Giles sees Oliver available nearby (Bonjour)', () => /Available nearby[\s\S]*● Oliver/.test(frame()))
    mkdirSync(join(dir, 'HackHack'))
    writeFileSync(join(dir, 'HackHack', 'README.md'), 'hi\n')
    const p = await giles.create(join(dir, 'HackHack')) // the creator's folder name is the project name
    await until('project and invite on screen', () => frame().includes('HackHack') && frame().includes(inviteFor(p)))

    const q = await oliver.join(inviteFor(p), join(dir, 'oliver'))
    assert.equal(q.name, 'HackHack')
    await until('Oliver has the files', () => existsSync(join(q.root, 'README.md')))
    await until('Oliver shows up online', () => /● Oliver/.test(frame()))

    writeFileSync(join(q.root, 'api.ts'), 'export {}\n')
    await until('Giles sees Oliver working on api.ts', () => /Oliver.*api\.ts/.test(frame()))
    await until('the activity log shows the download', () => frame().includes('↓ api.ts from Oliver'))

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
