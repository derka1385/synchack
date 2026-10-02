// The terminal UI: projects, who is editing which file, collisions about to happen, live
// activity, conflicts. Written with createElement (h) instead of JSX so Node can run it
// without a build step.
import React, { useEffect, useState } from 'react'
import { Box, Text, render, useApp, useInput, useWindowSize } from 'ink'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, resolve } from 'node:path'
import { lanAddresses, type Conflict, type Member } from '../shared/protocol.ts'
import { call, type ProjectSync } from './engine.ts'
import { conflictText, installCommand, inviteFor, keepLocal, previewLines, previewShare, refreshInvite, type Hub, type SharePreview } from './hub.ts'
import type { Project } from './state.ts'

const h = React.createElement

const HOT_MS = 10 * 60_000 // two people changing a file within this window = heads-up
const RECENT_MS = 30 * 60_000 // "working on" = changed within this window

const ago = (t: number) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  return s < 5 ? 'now' : s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`
}
const expand = (p: string) => resolve(p.replace(/^~(?=$|\/)/, homedir()))
const tilde = (path: string) => path.replace(homedir(), '~')
const who = (author: string | null) => (author ?? '?').replace(/ \(.*\)$/, '') // "Oliver (MacBook-Air)" → "Oliver"
const votes = (c: Conflict, x: 'A' | 'B') => Object.values(c.votes).filter(v => v === x).length
const copy = (text: string) => {
  const p = spawn('pbcopy')
  p.on('error', () => {})
  p.stdin.end(text)
}
const installLine = (hub: Hub) => hub.hosting && installCommand(hub.hosting.port, hub.hosting.cert)

// ── small building blocks ─────────────────────────────────────────────────

const title = (text: string, color = 'gray') => h(Text, { bold: true, color }, text.toUpperCase())
const gap = (key: string) => h(Text, { key }, ' ')
const keys = (pairs: [string, string][]) =>
  h(Text, { wrap: 'truncate' }, ...pairs.flatMap(([k, label]) => [h(Text, { key: k, inverse: true, bold: true }, ` ${k} `), h(Text, { key: `${k}l`, dimColor: true }, ` ${label}  `)]))
const panel = (props: object, ...children: React.ReactNode[]) => h(Box, { flexDirection: 'column', borderStyle: 'round', paddingX: 1, ...props }, ...children)

function syncState(s: ProjectSync | undefined): [string, string, string] {
  if (!s) return ['○', 'gray', 'starting']
  if (s.mode === 'paused') return ['‖', 'yellow', 'paused']
  if (!s.online) return ['○', 'red', 'offline, retrying']
  const pending = s.editing().length
  return pending ? ['●', 'yellow', `syncing ${pending}`] : ['●', 'green', s.mode === 'calm' ? 'calm · synced' : 'synced']
}

interface Prompt {
  label: string
  hint: string
  value: string
  run: (value: string) => Promise<string | void>
}

type View = 'home' | 'conflicts' | 'help'

export function App({ hub, web }: { hub: Hub; web?: string }) {
  const { exit } = useApp()
  const { rows = 24 } = useWindowSize()
  const [, rerender] = useState(0)
  const [sel, setSel] = useState(0)
  const [view, setView] = useState<View>('home')
  const [csel, setCsel] = useState(0)
  const [prompt, setPrompt] = useState<Prompt | null>(null)
  const [flash, setFlash] = useState<{ text: string; error?: boolean } | null>(null)
  const [preview, setPreview] = useState<{ id: string; text: string } | null>(null)
  const [confirm, setConfirm] = useState<{ dir: string; preview: SharePreview } | null>(null)

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
  const quit = () => void hub.close().then(exit)
  const share = async (dir: string) => {
    const np = await hub.create(dir)
    select(np.id)
    copy(inviteFor(np))
    return `Sharing ${np.name}. Invite copied: paste it to your teammates (${inviteFor(np)})`
  }

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
    if (key.ctrl && input === 'c') return quit()
    if (confirm) {
      if (key.return) void act(share(confirm.dir))
      if (key.return || key.escape) setConfirm(null)
      return
    }
    if (view === 'help') return setView('home') // any key closes help
    if (view === 'conflicts') {
      if (key.escape || input === 'x' || !p || !c) return setView('home')
      if (key.upArrow) return setCsel(i => Math.max(0, i - 1))
      if (key.downArrow) return setCsel(i => Math.min(conflicts.length - 1, i + 1))
      if (input === '1' || input === '2') return void act(call(p, 'POST', `/conflicts/${c.id}/vote`, { choice: input === '1' ? 'A' : 'B' }).then(() => `Voted ${input === '1' ? 'A' : 'B'} on ${c.path}`))
      if (input === 'a' || input === 'b') return void act(call(p, 'POST', `/conflicts/${c.id}/resolve`, { choice: input.toUpperCase() }).then(() => `${c.path}: kept ${input.toUpperCase()} for everyone`))
      if (input === 'm') return void act(keepLocal(p, c).then(() => `${c.path}: kept this Mac's file for everyone`))
      return
    }
    if (input === 'q') return quit()
    if (input === '?') return setView('help')
    if (input === 'w' && web) return void spawn('open', [web], { stdio: 'ignore', detached: true }).unref()
    if (key.upArrow) return setSel(i => Math.max(0, i - 1))
    if (key.downArrow) return setSel(i => Math.min(projects.length - 1, i + 1))
    if (input === 'n')
      return setPrompt({
        label: 'Share a folder',
        hint: 'new or existing (e.g. ~/Coding/my-app); its name becomes the project name',
        value: '~/HackHack',
        run: async v => {
          const dir = expand(v)
          // an existing project: show what would leave this Mac before anything does
          if (existsSync(dir) && readdirSync(dir).some(f => f !== '.DS_Store')) return void setConfirm({ dir, preview: previewShare(dir) })
          return share(dir)
        },
      })
    if (input === 'j')
      return setPrompt({
        label: 'Join a project',
        hint: 'paste the invite your teammate sent, like HX7-K92@192.168.1.129:8787#k3Jq…',
        value: '',
        run: async v => {
          const np = await hub.join(v)
          select(np.id)
          return `Joined ${np.name}: files arrive in ${tilde(np.root)}`
        },
      })
    if (!p || !sync) return
    if (input === 'p') return sync.setMode(sync.mode === 'paused' ? 'live' : 'paused')
    if (input === 'l' || input === 'c') return sync.setMode(input === 'l' ? 'live' : 'calm')
    if (input === 'i')
      return void act(
        refreshInvite(hub.state, p).then(invite => {
          copy(invite)
          return `Invite copied: ${invite} (works for 48 h)`
        }),
      )
    if (input === 'u' && hub.hosting) {
      copy(installCommand(hub.hosting.port, hub.hosting.cert))
      return setFlash({ text: 'Install command copied: teammates paste it into Terminal' })
    }
    if (input === 'o') return void spawn('open', [p.root], { stdio: 'ignore', detached: true }).unref()
    if (input === 'x' && conflicts.length) {
      setCsel(0)
      setView('conflicts')
    }
  })

  const main = confirm ? confirmPane(confirm.dir, confirm.preview) : view === 'help' ? helpPane() : !p || !sync ? welcomePane(hub) : view === 'conflicts' ? conflictPane(p, conflicts, csel, preview, rows) : projectPane(hub, p, sync, rows)

  return h(
    Box,
    { flexDirection: 'column', height: rows },
    header(hub),
    h(Box, { flexGrow: 1 }, sidebar(hub, projects, sel, sync), main),
    prompt
      ? panel(
          { borderColor: 'cyan' },
          h(Text, {}, h(Text, { bold: true, color: 'cyan' }, prompt.label), h(Text, { dimColor: true }, `  ${prompt.hint}`)),
          h(Text, {}, h(Text, { color: 'cyan' }, '› '), prompt.value, h(Text, { inverse: true }, ' '), h(Text, { dimColor: true }, '    enter ok · esc cancel')),
        )
      : null,
    h(
      Box,
      { paddingX: 1 },
      flash
        ? h(Text, { color: flash.error ? 'red' : 'green', wrap: 'truncate' }, `${flash.error ? '✕' : '✓'} ${flash.text}`)
        : confirm
          ? keys([['enter', 'share it'], ['esc', 'cancel']])
          : view === 'conflicts'
          ? keys([['↑↓', 'choose'], ['a', 'keep A'], ['b', 'keep B'], ['m', 'keep my file'], ['1', 'vote A'], ['2', 'vote B'], ['esc', 'back']])
          : p
            ? keys([['w', 'app'], ['n', 'share'], ['j', 'join'], ['i', 'invite'], ['p', sync?.mode === 'paused' ? 'resume' : 'pause'], ['o', 'Finder'], ...(conflicts.length ? [['x', 'conflicts'] as [string, string]] : []), ['?', 'help'], ['q', 'quit']])
            : keys([['w', 'open the app'], ['n', 'share a folder'], ['j', 'join'], ['?', 'help'], ['q', 'quit']]),
    ),
  )
}

// ── regions ───────────────────────────────────────────────────────────────

function header(hub: Hub) {
  const me = hub.state.identity()
  const engines = [...hub.engines.values()]
  const offline = engines.filter(s => s.mode !== 'paused' && !s.online).length
  const pending = engines.reduce((n, s) => n + s.editing().length, 0)
  const open = engines.reduce((n, s) => n + s.conflicts.size, 0)
  const state = open ? h(Text, { color: 'red' }, `⚠ ${open} conflict${open > 1 ? 's' : ''}`) : offline ? h(Text, { color: 'red' }, `○ ${offline} offline`) : pending ? h(Text, { color: 'yellow' }, `● syncing ${pending}`) : engines.length ? h(Text, { color: 'green' }, '● all synced') : null
  const where = hub.hosting
    ? h(Text, { dimColor: true }, `hosting ${lanAddresses()[0] ?? 'localhost'}:${hub.hosting.port}`)
    : h(Text, { color: hub.hostError ? 'yellow' : undefined, dimColor: !hub.hostError }, hub.hostError ?? `server ${hub.serverUrl}`)
  return h(
    Box,
    { paddingX: 1, justifyContent: 'space-between' },
    h(Text, { wrap: 'truncate' }, h(Text, { bold: true, color: 'cyan' }, '◆ synchack'), h(Text, { dimColor: true }, `   ${me.user} · ${me.deviceName}`)),
    h(Text, { wrap: 'truncate' }, where, state ? '   ' : '', state ?? ''),
  )
}

function sidebar(hub: Hub, projects: Project[], sel: number, sync: ProjectSync | undefined) {
  const team = new Set((sync?.members ?? []).map(m => `${m.name} (${m.deviceName})`))
  const nearby = [...hub.nearby.keys()].sort()
  return panel(
    { borderColor: 'gray', width: 28, flexShrink: 0 },
    title('Projects'),
    ...(projects.length
      ? projects.map((x, i) => {
          const s = hub.engines.get(x.id)
          const [dot, color] = syncState(s)
          const online = s?.members.filter(m => m.online).length ?? 0
          const chosen = i === sel
          return h(
            Text,
            { key: x.id, wrap: 'truncate' },
            h(Text, { color: 'cyan' }, chosen ? '▸ ' : '  '),
            h(Text, { color }, `${dot} `),
            h(Text, { bold: chosen, color: chosen ? 'cyan' : undefined }, x.name),
            s?.conflicts.size ? h(Text, { color: 'red' }, ` ⚠${s.conflicts.size}`) : '',
            h(Text, { dimColor: true }, online ? `  ${online} online` : ''),
          )
        })
      : [h(Text, { key: 'none', dimColor: true }, 'none yet')]),
    gap('g1'),
    title('Nearby'),
    ...(nearby.length
      ? nearby.map(n => {
          const [, name = n, device = ''] = n.match(/^(.*) \((.*)\)$/) ?? []
          const inProject = team.has(n)
          return h(
            Text,
            { key: `n${n}`, wrap: 'truncate' },
            h(Text, { color: inProject ? 'gray' : 'green' }, '● '),
            name,
            h(Text, { dimColor: true }, inProject ? '  in project' : `  ${device}`),
          )
        })
      : [h(Text, { key: 'nobody', dimColor: true, wrap: 'wrap' }, 'nobody else on this network runs synchack yet')]),
  )
}

function welcomePane(hub: Hub) {
  const install = installLine(hub)
  const step = (n: string, k: string, text: string) =>
    h(Text, { key: n }, h(Text, { color: 'cyan', bold: true }, ` ${n} `), '  ', k ? h(Text, { inverse: true, bold: true }, ` ${k} `) : '   ', `  ${text}`)
  return panel(
    { borderColor: 'cyan', flexGrow: 1 },
    h(Text, { bold: true, color: 'cyan' }, 'Welcome to synchack'),
    h(Text, { dimColor: true }, 'One real folder, shared live by the whole team. Agents and editors just see normal files.'),
    gap('g1'),
    step('1', 'n', 'share a folder, new or existing. This Mac hosts it.'),
    step('2', 'i', 'copy the invite and send it to your teammates.'),
    step('3', '', 'they open synchack, press j and paste it. Done.'),
    gap('g2'),
    h(Text, { dimColor: true }, 'Joining someone else? Press j and paste their invite.'),
    ...(install ? [gap('g3'), h(Text, { key: 'inst', dimColor: true }, 'Teammate without synchack? They run:'), h(Text, { key: 'cmd', color: 'cyan' }, `  ${install}`)] : []),
  )
}

function projectPane(hub: Hub, p: Project, sync: ProjectSync, rows: number) {
  const now = Date.now()
  const me = hub.state.device
  const [dot, color, label] = syncState(sync)
  const members: Member[] = sync.members.length ? sync.members : [{ device: me, name: hub.state.identity().user, deviceName: '', online: sync.online }]
  const editing = new Set(sync.editing())

  // who is on which file: their recent changes, plus what this Mac is editing right now
  const filesOf = (device: string) => {
    const recent = [...sync.activity]
      .flatMap(([path, edits]) => edits.filter(e => e.device === device && now - e.at < RECENT_MS).slice(0, 1).map(e => ({ path, at: e.at, deleted: e.deleted })))
      .sort((x, y) => y.at - x.at)
    const live = device === me ? [...editing].map(path => ({ path, at: now, live: true })) : []
    const seen = new Set<string>()
    return [...live, ...recent].filter(f => !seen.has(f.path) && seen.add(f.path)).slice(0, 3)
  }

  const conflicted = new Set([...sync.conflicts.values()].map(c => c.path))
  // heads-up: a file several people changed recently (or that this Mac is editing right now)
  const names = new Map(members.map(m => [m.device, m.device === me ? 'you' : m.name]))
  const hot = [...sync.activity]
    .map(([path, edits]) => {
      const people = new Set(edits.filter(e => now - e.at < HOT_MS).map(e => e.device))
      if (editing.has(path)) people.add(me)
      return { path, people: [...people].map(d => names.get(d) ?? '?') }
    })
    .filter(x => x.people.length > 1 && !conflicted.has(x.path)) // a real conflict is shown below instead
    .slice(0, 2)

  const conflicts = [...sync.conflicts.values()]
  const errors = [...sync.errors].slice(0, 2)
  const logs = hub.logs.get(p.id) ?? []
  const used = 12 + members.length + (hot.length ? hot.length + 2 : 0) + (conflicts.length ? conflicts.length + 2 : 0) + errors.length
  const room = Math.max(3, rows - used - 6)
  const install = installLine(hub)

  return panel(
    { borderColor: 'cyan', flexGrow: 1 },
    h(
      Box,
      {},
      h(Box, { flexGrow: 1, flexShrink: 1, minWidth: 0 }, h(Text, { wrap: 'truncate' }, h(Text, { bold: true, color: 'cyan' }, p.name), h(Text, { dimColor: true }, `   ${tilde(p.root)}`))),
      h(Box, { flexShrink: 0 }, h(Text, {}, h(Text, { color }, `  ${dot} ${label}`), h(Text, { dimColor: true }, ` · ${sync.mode}`))),
    ),
    // invites and the install command carry a key hash, so they are long: wrap rather than cut them
    h(Text, { wrap: 'wrap' }, h(Text, { dimColor: true }, 'invite   '), h(Text, { bold: true }, inviteFor(p)), h(Text, { dimColor: true }, '   i copies a fresh one')),
    install ? h(Text, { wrap: 'wrap', dimColor: true }, `new Mac  ${install}   (u copies it)`) : null,
    gap('g1'),
    title('Team'),
    ...members.map(m => {
      const files = filesOf(m.device)
      const you = m.device === me
      return h(
        Box,
        { key: m.device },
        h(Box, { width: 18, flexShrink: 0 }, h(Text, { wrap: 'truncate' }, h(Text, { color: m.online ? 'green' : 'gray' }, m.online ? '● ' : '○ '), h(Text, { bold: you }, m.name), h(Text, { dimColor: true }, you ? ' you' : ''))),
        h(
          Text,
          { wrap: 'truncate' },
          ...(files.length
            ? files.flatMap((f, i) => [
                i ? h(Text, { key: `s${i}`, dimColor: true }, '   ') : '',
                'live' in f ? h(Text, { key: `e${i}`, color: 'yellow' }, '✎ ') : '',
                h(Text, { key: `f${i}`, strikethrough: 'deleted' in f && f.deleted }, f.path),
                h(Text, { key: `t${i}`, dimColor: true }, ` ${'live' in f ? 'editing' : ago(f.at)}`),
              ])
            : [h(Text, { key: 'idle', dimColor: true }, m.online ? 'idle' : 'offline')]),
        ),
      )
    }),
    ...(hot.length
      ? [
          gap('g2'),
          title('Heads-up · same file, talk before it conflicts', 'yellow'),
          ...hot.map(x => h(Text, { key: `h${x.path}`, color: 'yellow', wrap: 'truncate' }, `⚡ ${x.path}  ${x.people.join(' and ')} both changed it in the last 10 min`)),
        ]
      : []),
    ...(conflicts.length
      ? [
          gap('g3'),
          title('Conflicts · x to review', 'red'),
          ...conflicts.map(c => h(Text, { key: c.id, color: 'red', wrap: 'truncate' }, `⚠ ${c.path}   ${who(c.a.author)} vs ${who(c.b.author)}   votes A ${votes(c, 'A')} · B ${votes(c, 'B')}`)),
        ]
      : []),
    ...errors.map(([path, msg]) => h(Text, { key: `e${path}`, color: 'red', wrap: 'truncate' }, `✕ ${path || 'sync'}: ${msg}`)),
    gap('g4'),
    title('Activity'),
    ...(logs.length ? logs.slice(-room).map((l, i) => activityLine(l, i)) : [h(Text, { key: 'none', dimColor: true }, 'nothing yet: edits from anyone show up here')]),
  )
}

function activityLine(line: string, i: number) {
  const [, time = '', rest = line] = line.match(/^(\S+(?: [AP]M)?) (.*)$/) ?? []
  const color = rest.startsWith('↑') ? 'cyan' : rest.startsWith('↓') ? 'green' : rest.startsWith('merged') ? 'yellow' : /^conflict|offline|error|✕|refused|missing/.test(rest) ? 'red' : undefined
  return h(Text, { key: `l${i}`, wrap: 'truncate' }, h(Text, { dimColor: true }, `${time}  `), h(Text, { color, dimColor: !color }, rest))
}

function conflictPane(p: Project, conflicts: Conflict[], csel: number, preview: { id: string; text: string } | null, rows: number) {
  const c = conflicts[Math.min(csel, conflicts.length - 1)]
  if (!c) return panel({ borderColor: 'green', flexGrow: 1 }, h(Text, { color: 'green' }, '✓ No open conflicts. Press esc.'))
  const side = (x: 'A' | 'B', s: Conflict['a'], color: string) =>
    h(Text, { key: x, wrap: 'truncate' }, h(Text, { color, bold: true }, ` ${x} `), ` ${who(s.author)}`, h(Text, { dimColor: true }, `  ${new Date(s.at).toLocaleTimeString()}${s.hash === null ? '  deleted the file' : ''}   votes ${votes(c, x)}`))
  // colour the two sides of each marker block
  let region: string | undefined
  const lines = (preview?.id === c.id ? preview.text.split('\n') : ['loading…']).slice(0, Math.max(5, rows - 13 - conflicts.length)).map((l, i) => {
    let color = region
    if (l.startsWith('<<<<<<<')) (region = 'cyan'), (color = 'cyan')
    else if (l.startsWith('|||||||')) (region = 'gray'), (color = 'gray')
    else if (l.startsWith('=======')) (region = 'magenta'), (color = 'gray')
    else if (l.startsWith('>>>>>>>')) (region = undefined), (color = 'magenta')
    return h(Text, { key: i, color, wrap: 'truncate' }, l || ' ')
  })
  return panel(
    { borderColor: 'red', flexGrow: 1 },
    h(Text, {}, h(Text, { bold: true, color: 'red' }, `Conflict ${Math.min(csel, conflicts.length - 1) + 1}/${conflicts.length}`), h(Text, { bold: true }, `  ${c.path}`), h(Text, { dimColor: true }, `   in ${p.name}`)),
    ...(conflicts.length > 1 ? conflicts.map((x, i) => h(Text, { key: x.id, dimColor: i !== csel, wrap: 'truncate' }, `${i === csel ? '▸' : ' '} ${x.path}`)) : []),
    gap('g1'),
    side('A', c.a, 'cyan'),
    side('B', c.b, 'magenta'),
    h(Text, { dimColor: true }, 'Nothing is lost: both versions stay on the server. Each Mac keeps its own until you choose.'),
    gap('g2'),
    ...lines,
  )
}

function confirmPane(dir: string, preview: SharePreview) {
  const style = { ok: ['✓', 'green'], safe: ['●', 'green'], skip: ['✕', 'gray'], info: ['i', 'cyan'], warn: ['⚠', 'yellow'] } as const
  return panel(
    { borderColor: 'yellow', flexGrow: 1 },
    h(Text, { wrap: 'truncate' }, h(Text, { bold: true, color: 'yellow' }, `Share ${basename(dir)}?`), h(Text, { dimColor: true }, `   ${tilde(dir)}`)),
    gap('g0'),
    ...previewLines(preview).map(([kind, text], i) => h(Text, { key: i }, h(Text, { color: style[kind][1], bold: true }, `${style[kind][0]} `), h(Text, { dimColor: kind === 'skip' }, text))),
    gap('g1'),
    h(Text, { dimColor: true }, 'Need to keep more on this Mac? Add lines to .synchackignore in that folder (like .gitignore), then press n again.'),
  )
}

function helpPane() {
  const row = (k: string, text: string) => h(Text, { key: k }, h(Text, { inverse: true, bold: true }, ` ${k.padEnd(3)}`), `  ${text}`)
  return panel(
    { borderColor: 'cyan', flexGrow: 1 },
    h(Text, { bold: true, color: 'cyan' }, 'Keys'),
    gap('g0'),
    row('w', 'open the synchack app in your browser'),
    row('n', 'share a folder (new or existing); this Mac hosts it'),
    row('j', 'join a project by pasting an invite'),
    row('i', 'copy a fresh invite for the selected project (works for 48 h)'),
    row('u', 'copy the install command for teammates without synchack'),
    row('↑↓', 'choose a project'),
    row('l', 'live: changes go out about 0.4 s after you save'),
    row('c', 'calm: changes go out after 15 s without edits'),
    row('p', 'pause / resume: nothing in or out while paused; catches up on resume'),
    row('o', 'open the project folder in Finder'),
    row('x', 'review conflicts: keep A, keep B, keep your file, or vote'),
    row('q', 'quit (syncing stops until you open synchack again)'),
    gap('g1'),
    title('Good to know'),
    h(Text, { dimColor: true }, '✎ = a file you are editing right now · ⚡ = two people changed the same file recently'),
    h(Text, { dimColor: true }, '.env, node_modules and .git never leave your Mac. Add more rules in .synchackignore.'),
    gap('g2'),
    h(Text, { dimColor: true }, 'Press any key to go back.'),
  )
}

export async function runTui(hub: Hub, web?: string) {
  const app = render(h(App, { hub, web }), { exitOnCtrlC: false })
  await app.waitUntilExit()
}
