#!/usr/bin/env node
// synchack: share a project folder with your team. Agents and editors keep using plain files.
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { type Candidate, type Conflict, type Member, type Mode } from '../shared/protocol.ts'
import { LocalState, type Project } from './state.ts'
import { call, createProject, joinProject } from './engine.ts'
import { Hub, alive, conflictText, freeFolder, inviteFor, keepLocal, parseInvite, refreshInvite, removeMember } from './hub.ts'
import { runTui } from './tui.ts'
import { hostIdentity } from './net.ts'

const HELP = `synchack: keep one project folder in sync across your team's Macs

  synchack                              open the terminal interface (share, join, see who edits what)
  synchack create [dir] [--name NAME]   share a folder (existing files are imported) and print the invite
  synchack join INVITE [dir]            join with an invite like HX7-K92@192.168.1.129:8787#k3Jq…
                                        (the folder defaults to ~/<project name>)
  synchack run                          keep every project on this Mac in sync, without the interface
  synchack status                       projects, sync state, teammates, open conflicts
  synchack live | calm | pause [dir]    live ≈0.4 s · calm: batches after 15 s quiet · pause: nothing in or out
  synchack conflicts [dir]              list open conflicts
  synchack show ID [dir]                print both versions with conflict markers
  synchack vote ID A|B [dir]
  synchack resolve ID A|B|mine [dir]    mine = the file as it is on this Mac now (e.g. hand-merged)
  synchack open [dir]                   open the project folder in Finder
  synchack invite [dir] [--new]         print the invite (works for 48 h); --new replaces it
  synchack members [dir]                list teammates
  synchack remove NAME|DEVICE [dir]     remove a teammate (creator only; also replaces the invite)
  synchack leave [dir]                  stop being a member of the project (files stay)

  --server URL   use that server instead of hosting projects on this Mac (or $SYNCHACK_SERVER)
  --user NAME    how teammates see you (remembered)
  $SYNCHACK_HOME holds this Mac's sync state (default ~/Library/Application Support/SyncHack)
  $SYNCHACK_PORT is the port this Mac hosts on (default 8787)
`

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: { server: { type: 'string' }, name: { type: 'string' }, user: { type: 'string' }, force: { type: 'boolean' }, new: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
})
const [cmd, ...args] = positionals
const state = new LocalState(process.env.SYNCHACK_HOME ?? join(homedir(), 'Library', 'Application Support', 'SyncHack'))
if (opt.user) state.setMeta('user', opt.user)
const explicitServer = (opt.server ?? process.env.SYNCHACK_SERVER)?.replace(/\/+$/, '')
const port = Number(process.env.SYNCHACK_PORT) || undefined // where this Mac hosts (default 8787)
const time = () => new Date().toLocaleTimeString()

function die(msg: string): never {
  console.error(msg)
  process.exit(1)
}

const real = (dir: string) => (existsSync(dir) ? realpathSync(dir) : resolve(dir))
const here = (dir = '.') => state.projectAt(real(dir)) ?? die(`${resolve(dir)} is not inside a synchack project (see: synchack status)`)

function daemonPid() {
  const pid = Number(state.meta('daemon'))
  return pid && pid !== process.pid && alive(pid) ? pid : 0
}

/** Syncs every project here (and hosts the ones created here) until Ctrl-C, logging to the terminal. */
async function foreground(work?: (hub: Hub) => Promise<unknown>) {
  const hub = new Hub(state, { server: explicitServer, port })
  hub.on('log', (p: Project, line: string) => console.log(`${time()} [${p.name}] ${line}`))
  await hub.start().catch(e => die(e.message))
  if (hub.hostError) console.log(hub.hostError)
  await work?.(hub)
  console.log(`syncing ${hub.engines.size} project(s); Ctrl-C to stop`)
  const quit = () => hub.close().then(() => process.exit(0))
  process.once('SIGINT', quit)
  process.once('SIGTERM', quit)
}

function printConflict(c: Conflict) {
  const tally = (x: 'A' | 'B') => Object.values(c.votes).filter(v => v === x).length
  const side = (x: Candidate) => `${x.author ?? 'unknown'}, ${new Date(x.at).toLocaleTimeString()}${x.hash === null ? ' (deleted the file)' : ''}`
  console.log(`${c.id}  ${c.path}\n  A: ${side(c.a)}\n  B: ${side(c.b)}\n  votes: A ${tally('A')} · B ${tally('B')}\n`)
}

const shared = (p: Project) => console.log(`Sharing "${p.name}" from ${p.root}\n\n  invite: ${inviteFor(p)}\n\nTeammates run:  synchack join ${inviteFor(p)}\n`)

async function main() {
  switch (cmd) {
    case undefined: {
      if (!process.stdout.isTTY || opt.help) return console.log(HELP)
      const hub = new Hub(state, { server: explicitServer, port })
      await hub.start().catch(e => die(e.message))
      await runTui(hub)
      return process.exit(0)
    }
    case 'create': {
      const dir = resolve(args[0] ?? '.')
      const pid = daemonPid()
      if (!pid) return foreground(async hub => shared(await hub.create(dir, opt.name)))
      // A running synchack hosts on this Mac; it picks the new project up within a second.
      const cert = explicitServer ? null : (hostIdentity(join(state.home, 'tls'))?.cert ?? null)
      shared(await createProject(state, explicitServer ?? `${cert ? 'https' : 'http'}://localhost:${port ?? 8787}`, dir, opt.name, cert))
      return console.log(`The running synchack (pid ${pid}) syncs it.`)
    }
    case 'join': {
      if (!args[0]) die('usage: synchack join INVITE [dir]   (INVITE looks like HX7-K92@192.168.1.129:8787)')
      const invite = args[0].includes('@') ? args[0] : explicitServer ? `${args[0]}@${explicitServer}` : die('that is only a code: paste the whole invite, like HX7-K92@192.168.1.129:8787')
      const dir = args[1] && resolve(args[1])
      if (dir && existsSync(dir) && readdirSync(dir).some(f => f !== '.DS_Store') && !opt.force)
        die(`${dir} is not empty. Join into an empty folder, or pass --force (files that differ become conflicts).`)
      const pid = daemonPid()
      if (!pid) return foreground(async hub => console.log(`Joined "${(await hub.join(invite, dir)).name}"`))
      const { code, server, pin } = parseInvite(invite)
      const p = await joinProject(state, server, code, name => dir ?? freeFolder(name), pin)
      return console.log(`Joined "${p.name}" into ${p.root}; the running synchack (pid ${pid}) syncs it.`)
    }
    case 'run':
      return foreground()
    case 'status': {
      const projects = state.projects()
      if (!projects.length) return console.log('No projects yet. Run "synchack" to share a folder or join one.')
      const pid = daemonPid()
      console.log(pid ? `synchack is running (pid ${pid})` : 'synchack is not running; start it with: synchack')
      for (const p of projects) {
        const s = state.status(p.id)
        const live = pid && s && Date.now() - s.at < 5000
        const conn = live ? (s.online ? 'online' : 'offline, retrying') : 'not syncing'
        console.log(`\n${p.name}  ${p.root}\n  invite ${inviteFor(p)} · mode ${p.mode} · ${conn}${live && s.pending ? ` · ${s.pending} pending` : ''}`)
        if (!live) continue
        if (s.members.length) console.log(`  team: ${s.members.map((m: Member) => `${m.name} (${m.deviceName})${m.online ? ' ●' : ''}`).join(', ')}`)
        for (const c of s.conflicts as Conflict[]) console.log(`  ⚠ conflict ${c.id} on ${c.path}: synchack show ${c.id}`)
        for (const [path, err] of Object.entries(s.errors)) console.log(`  ! ${path || 'sync'}: ${err}`)
      }
      return
    }
    case 'live':
    case 'calm':
    case 'pause': {
      const p = here(args[0])
      const mode: Mode = cmd === 'pause' ? 'paused' : cmd
      state.setMode(p.id, mode)
      return console.log(`${p.name}: ${mode}${daemonPid() ? '' : ' (applies once synchack runs)'}`)
    }
    case 'conflicts': {
      const { conflicts } = await call(here(args[0]), 'GET', '/conflicts')
      if (!conflicts.length) console.log('No open conflicts.')
      for (const c of conflicts) printConflict(c)
      return
    }
    case 'show': {
      const [id, dir] = args
      if (!id) die('usage: synchack show ID [dir]')
      const p = here(dir)
      const c: Conflict = await call(p, 'GET', `/conflicts/${id}`)
      printConflict(c)
      return void process.stdout.write(await conflictText(p, c))
    }
    case 'vote': {
      const [id, choice, dir] = args
      if (!id || (choice !== 'A' && choice !== 'B')) die('usage: synchack vote ID A|B [dir]')
      return printConflict(await call(here(dir), 'POST', `/conflicts/${id}/vote`, { choice }))
    }
    case 'resolve': {
      const [id, choice, dir] = args
      if (!id || !['A', 'B', 'mine'].includes(choice)) die('usage: synchack resolve ID A|B|mine [dir]')
      const p = here(dir)
      const r = choice === 'mine' ? await keepLocal(p, await call(p, 'GET', `/conflicts/${id}`)) : await call(p, 'POST', `/conflicts/${id}/resolve`, { choice })
      return console.log(`Resolved ${r.conflict.path} as v${r.head.version}; every teammate's copy updates now.`)
    }
    case 'invite':
      return console.log(await refreshInvite(state, here(args[0]), opt.new))
    case 'members': {
      const { members } = await call(here(args[0]), 'GET', '/members')
      for (const m of members as Member[])
        console.log(`${m.name} (${m.deviceName})${m.owner ? ' · creator' : ''}${m.online ? ' · online' : ''}${m.device === state.device ? ' · this Mac' : ''}  ${m.device}`)
      return
    }
    case 'remove': {
      const [who, dir] = args
      if (!who) die('usage: synchack remove NAME|DEVICE [dir]   (see: synchack members)')
      const p = here(dir)
      const { members } = await call(p, 'GET', '/members')
      const hits = (members as Member[]).filter(m => m.device === who || m.name.toLowerCase() === who.toLowerCase())
      if (hits.length !== 1) die(hits.length ? `${who} matches ${hits.length} devices; use the device id from: synchack members` : `no teammate called ${who} (see: synchack members)`)
      if (hits[0].device === state.device) die('that is this Mac; use: synchack leave')
      await removeMember(state, p, hits[0].device)
      return console.log(`Removed ${hits[0].name} (${hits[0].deviceName}). New invite: ${inviteFor(p)}`)
    }
    case 'leave': {
      const p = here(args[0])
      await removeMember(state, p, state.device)
      return console.log(`Left "${p.name}". The files in ${p.root} stay; they no longer sync.`)
    }
    case 'open':
      return void spawn('open', [here(args[0]).root], { stdio: 'ignore', detached: true }).unref()
    default:
      console.log(HELP)
  }
}

main().catch(e => die(`synchack: ${(e as Error).message}`))
