// The terminal UI: projects, who is editing which file, live activity, conflicts.
// Written with createElement (h) instead of JSX so Node can run it without a build step.
import React, { useEffect, useState } from 'react'
import { Box, Text, render, useApp, useInput, useWindowSize } from 'ink'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { lanAddresses, type Conflict } from '../shared/protocol.ts'
import { call } from './engine.ts'
import { conflictText, installCommand, inviteFor, keepLocal, refreshInvite, type Hub } from './hub.ts'
import type { Project } from './state.ts'

const h = React.createElement

const ago = (t: number) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`
}
const expand = (p: string) => resolve(p.replace(/^~(?=$|\/)/, homedir()))
const copy = (text: string) => {
  const p = spawn('pbcopy')
  p.on('error', () => {})
  p.stdin.end(text)
}
const who = (author: string | null) => (author ?? '?').replace(/ \(.*\)$/, '') // "Oliver (MacBook-Air)" → "Oliver"
const tilde = (path: string) => path.replace(homedir(), '~')
const votes = (c: Conflict, x: 'A' | 'B') => Object.values(c.votes).filter(v => v === x).length

interface Prompt {
  label: string
  value: string
  run: (value: string) => Promise<string | void>
}

export function App({ hub }: { hub: Hub }) {
  const { exit } = useApp()
  const { rows } = useWindowSize()
  const [, rerender] = useState(0)
  const [sel, setSel] = useState(0)
  const [view, setView] = useState<'home' | 'conflicts'>('home')
  const [csel, setCsel] = useState(0)
  const [prompt, setPrompt] = useState<Prompt | null>(null)
  const [flash, setFlash] = useState<{ text: string; error?: boolean } | null>(null)
  const [preview, setPreview] = useState<{ id: string; text: string } | null>(null)

  useEffect(() => {
    let queued = false
    const update = () => {
      if (queued) return
      queued = true
      setTimeout(() => ((queued = false), rerender(n => n + 1)), 100)
    }
    const clock = setInterval(update, 1000) // keeps "12s ago" moving
    hub.on('update', update)
    return () => {
      clearInterval(clock)
      hub.off('update', update)
    }
  }, [hub])

  const projects = hub.state.projects()
  const p: Project | undefined = projects[Math.min(sel, projects.length - 1)]
  const sync = p && hub.engines.get(p.id)
  const conflicts = sync ? [...sync.conflicts.values()] : []
  const c: Conflict | undefined = conflicts[Math.min(csel, conflicts.length - 1)]

  useEffect(() => {
    if (view !== 'conflicts' || !p || !c || preview?.id === c.id) return
    let live = true
    conflictText(p, c).then(text => live && setPreview({ id: c.id, text }), () => {})
    return () => void (live = false)
  }, [view, c?.id])

  const act = (work: Promise<string | void>) => work.then(msg => msg && setFlash({ text: msg }), e => setFlash({ text: e.message, error: true }))
  const select = (id: string) => setSel(hub.state.projects().findIndex(x => x.id === id))

  useInput((input, key) => {
    if (prompt) {
      if (key.escape) return setPrompt(null)
      if (key.return) {
        setPrompt(null)
        return void act(prompt.run(prompt.value.trim()))
      }
      if (key.backspace || key.delete) return setPrompt({ ...prompt, value: prompt.value.slice(0, -1) })
      if (input && !key.ctrl && !key.meta) setPrompt({ ...prompt, value: prompt.value + input })
      return
    }
    setFlash(null)
    if (key.ctrl && input === 'c') return void hub.close().then(exit)
    if (view === 'conflicts') {
      if (key.escape || input === 'x' || !p || !c) return setView('home')
      if (key.upArrow) return setCsel(i => Math.max(0, i - 1))
      if (key.downArrow) return setCsel(i => Math.min(conflicts.length - 1, i + 1))
      if (input === '1' || input === '2') return void act(call(p, 'POST', `/conflicts/${c.id}/vote`, { choice: input === '1' ? 'A' : 'B' }).then(() => 'vote sent'))
      if (input === 'a' || input === 'b') return void act(call(p, 'POST', `/conflicts/${c.id}/resolve`, { choice: input.toUpperCase() }).then(() => `${c.path}: kept ${input.toUpperCase()} for everyone`))
      if (input === 'm') return void act(keepLocal(p, c).then(() => `${c.path}: kept this Mac's file for everyone`))
      return
    }
    if (input === 'q') return void hub.close().then(exit)
    if (key.upArrow) return setSel(i => Math.max(0, i - 1))
    if (key.downArrow) return setSel(i => Math.min(projects.length - 1, i + 1))
    if (input === 'n')
      return setPrompt({
        label: 'Folder to share, new or existing (its name is the project name)',
        value: '~/HackHack',
        run: async v => {
          const np = await hub.create(expand(v))
          select(np.id)
          copy(inviteFor(np))
          return `Sharing ${np.name}. Invite copied to the clipboard: ${inviteFor(np)}`
        },
      })
    if (input === 'j')
      return setPrompt({
        label: 'Paste the invite (looks like HX7-K92@192.168.1.129:8787#k3Jq…)',
        value: '',
        run: async v => {
          const np = await hub.join(v)
          select(np.id)
          return `Joined ${np.name}: files arrive in ${np.root}`
        },
      })
    if (!p || !sync) return
    if (input === 'l' || input === 'c' || input === 'p') return sync.setMode(input === 'l' ? 'live' : input === 'c' ? 'calm' : 'paused')
    if (input === 'i')
      return void act(
        refreshInvite(hub.state, p).then(invite => {
          copy(invite)
          return `Invite copied to the clipboard: ${invite} (works for 48 h)`
        }),
      )
    if (input === 'o') return void spawn('open', [p.root], { stdio: 'ignore', detached: true }).unref()
    if (input === 'x' && conflicts.length) {
      setCsel(0)
      setView('conflicts')
    }
  })

  const me = hub.state.identity()
  const install = hub.hosting && installCommand(hub.hosting.port, hub.hosting.cert)
  const where = hub.hosting ? `hosting on ${lanAddresses()[0] ?? 'localhost'}:${hub.hosting.port}` : (hub.hostError ?? `server ${hub.serverUrl}`)

  // Everyone on this network running synchack; teammates of the selected project are marked.
  const team = new Set((sync?.members ?? []).map(m => `${m.name} (${m.deviceName})`))
  const nearby = [...hub.nearby.keys()].sort().map(n => {
    const [, name = n, device = ''] = n.match(/^(.*) \((.*)\)$/) ?? []
    return [name, device, team.has(n)] as const
  })

  const projectList = h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', width: 24, paddingX: 1, flexShrink: 0 },
    h(Text, { bold: true }, 'Projects'),
    projects.length
      ? projects.map((x, i) => {
          const s = hub.engines.get(x.id)
          const state = !s ? ['○', 'gray'] : s.mode === 'paused' ? ['‖', 'yellow'] : s.online ? ['●', 'green'] : ['○', 'red']
          return h(
            Text,
            { key: x.id, inverse: i === sel, wrap: 'truncate' },
            h(Text, { color: state[1] }, state[0]),
            ` ${x.name}`,
            s?.conflicts.size ? h(Text, { color: 'red' }, ` ⚠${s.conflicts.size}`) : '',
          )
        })
      : h(Text, { dimColor: true }, 'None yet.\nn  share a folder\nj  join with an invite'),
    h(Text, { bold: true }, '\nAvailable nearby'),
    ...(nearby.length
      ? nearby.map(([name, device, inProject]) =>
          h(
            Text,
            { key: `n${name}${device}`, wrap: 'truncate' },
            h(Text, { color: inProject ? 'gray' : 'green' }, '● '),
            name,
            h(Text, { dimColor: true }, inProject ? ' (in project)' : ` ${device}`),
          ),
        )
      : [h(Text, { key: 'nobody', dimColor: true }, 'nobody on this\nnetwork yet')]),
  )

  const footer = prompt
    ? h(Text, {}, h(Text, { color: 'cyan' }, `${prompt.label}: `), prompt.value, h(Text, { inverse: true }, ' '), h(Text, { dimColor: true }, '   enter ok · esc cancel'))
    : flash
      ? h(Text, { color: flash.error ? 'red' : 'green', wrap: 'truncate' }, flash.text)
      : h(
          Text,
          { dimColor: true, wrap: 'truncate' },
          view === 'conflicts'
            ? '↑↓ choose · a keep A · b keep B · m keep my file · 1/2 vote · esc back'
            : 'n share · j join · ↑↓ project · i invite · l/c/p live/calm/pause · o Finder · x conflicts · q quit',
        )

  return h(
    Box,
    { flexDirection: 'column' },
    h(Box, { paddingX: 1 }, h(Text, { bold: true, color: 'cyan' }, 'synchack'), h(Text, { dimColor: true }, `  ${me.user} · ${me.deviceName} · ${where}`)),
    install ? h(Box, { paddingX: 1 }, h(Text, { dimColor: true, wrap: 'truncate' }, 'teammates without synchack: '), h(Text, { wrap: 'truncate' }, install)) : null,
    h(Box, {}, projectList, p && sync ? (view === 'conflicts' ? conflictPane(p, conflicts, csel, preview, rows) : projectPane(hub, p, rows)) : null),
    h(Box, { paddingX: 1 }, footer),
  )
}

function projectPane(hub: Hub, p: Project, rows: number) {
  const sync = hub.engines.get(p.id)!
  const now = Date.now()
  const members = sync.members.length ? sync.members : [{ device: hub.state.device, name: hub.state.identity().user, deviceName: '', online: sync.online }]
  const working = (device: string) => {
    const mine = device === hub.state.device ? sync.editing().map(f => `${f} (editing)`) : []
    const recent = [...sync.activity]
      .filter(([, a]) => a.device === device && now - a.at < 30 * 60_000)
      .sort((x, y) => y[1].at - x[1].at)
      .map(([path, a]) => `${path}${a.deleted ? ' (deleted)' : ''} ${ago(a.at)}`)
    return [...mine, ...recent].slice(0, 3)
  }
  const conflicts = [...sync.conflicts.values()]
  const errors = [...sync.errors].slice(0, 3)
  const logs = hub.logs.get(p.id) ?? []
  const room = Math.max(3, rows - 14 - members.length - (conflicts.length ? conflicts.length + 1 : 0) - errors.length)
  const status = sync.mode === 'paused' ? h(Text, { color: 'yellow' }, 'paused') : sync.online ? h(Text, { color: 'green' }, `${sync.mode} · online`) : h(Text, { color: 'red' }, `${sync.mode} · offline, retrying`)

  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', flexGrow: 1, paddingX: 1 },
    h(Text, { wrap: 'truncate' }, h(Text, { bold: true }, p.name), '  ', status, h(Text, { dimColor: true }, `  ${tilde(p.root)}`)),
    h(Text, { wrap: 'truncate' }, h(Text, { dimColor: true }, 'invite  '), h(Text, { bold: true }, inviteFor(p)), h(Text, { dimColor: true }, '  (i copies it)')),
    h(Text, { bold: true }, '\nTeam'),
    ...members.map(m => {
      const files = working(m.device)
      const label = `${m.name}${m.device === hub.state.device ? ' (you)' : ''}`
      return h(
        Text,
        { key: m.device, wrap: 'truncate' },
        h(Text, { color: m.online ? 'green' : 'gray' }, m.online ? '● ' : '○ '),
        label.padEnd(20).slice(0, 20),
        files.length ? files.join(', ') : h(Text, { dimColor: true }, m.online ? 'idle' : 'offline'),
      )
    }),
    ...(conflicts.length
      ? [
          h(Text, { key: 'ch', bold: true, color: 'red' }, '\nConflicts (x to review)'),
          ...conflicts.map(c => h(Text, { key: c.id, color: 'red', wrap: 'truncate' }, `⚠ ${c.path}   A ${who(c.a.author)} · B ${who(c.b.author)}   votes A${votes(c, 'A')} B${votes(c, 'B')}`)),
        ]
      : []),
    ...errors.map(([path, msg]) => h(Text, { key: `e${path}`, color: 'red', wrap: 'truncate' }, `! ${path || 'sync'}: ${msg}`)),
    h(Text, { bold: true }, '\nActivity'),
    ...(logs.length ? logs.slice(-room).map((l, i) => h(Text, { key: `l${i}`, wrap: 'truncate', dimColor: true }, l)) : [h(Text, { key: 'none', dimColor: true }, 'nothing yet')]),
  )
}

function conflictPane(p: Project, conflicts: Conflict[], csel: number, preview: { id: string; text: string } | null, rows: number) {
  const c = conflicts[Math.min(csel, conflicts.length - 1)]
  const lines = preview && c && preview.id === c.id ? preview.text.split('\n').slice(0, Math.max(5, rows - 10 - conflicts.length)) : ['loading…']
  const color = (l: string) => (/^(<<<<<<<|>>>>>>>|=======|\|\|\|\|\|\|\|)/.test(l) ? 'red' : undefined)
  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'red', flexGrow: 1, paddingX: 1 },
    h(Text, { bold: true }, `Conflicts in ${p.name}`),
    ...conflicts.map((x, i) =>
      h(Text, { key: x.id, inverse: i === csel, wrap: 'truncate' }, `${x.path}   A ${who(x.a.author)}${x.a.hash === null ? ' (deleted it)' : ''} · B ${who(x.b.author)}${x.b.hash === null ? ' (deleted it)' : ''}   votes A${votes(x, 'A')} B${votes(x, 'B')}`),
    ),
    h(Text, {}, ' '),
    ...lines.map((l, i) => h(Text, { key: i, color: color(l), wrap: 'truncate' }, l || ' ')),
  )
}

export async function runTui(hub: Hub) {
  const app = render(h(App, { hub }), { exitOnCtrlC: false })
  await app.waitUntilExit()
}
