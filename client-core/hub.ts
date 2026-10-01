// The background half of synchack: syncs every project on this Mac and hosts the ones
// created here. Used by the terminal UI and by `synchack run`.
import { EventEmitter } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { startServer, type Server } from '../server/server.ts'
import { lanAddresses, sha256, type Conflict, type Hash } from '../shared/protocol.ts'
import { decode, isText, merge3 } from '../shared/merge.ts'
import { ProjectSync, call, createProject, joinProject, type SyncOptions } from './engine.ts'
import type { LocalState, Project } from './state.ts'

export const DEFAULT_PORT = 8787
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]']

/** "HX7-K92@192.168.1.129:8787": everything a teammate needs, in one paste. */
export function inviteFor(p: Pick<Project, 'code' | 'server'>) {
  const u = new URL(p.server)
  if (u.protocol === 'https:') return `${p.code}@${u.origin}`
  const host = LOOPBACK.includes(u.hostname) ? (lanAddresses()[0] ?? u.hostname) : u.hostname
  return `${p.code}@${host}:${u.port || DEFAULT_PORT}`
}

export function parseInvite(invite: string) {
  const m = invite.trim().match(/^([A-Za-z0-9]{3}-?[A-Za-z0-9]{3})@(\S+)$/)
  if (!m) throw new Error('an invite looks like HX7-K92@192.168.1.129:8787')
  const addr = m[2].replace(/\/+$/, '')
  const server = /^https?:\/\//.test(addr) ? addr : `http://${addr.includes(':') ? addr : `${addr}:${DEFAULT_PORT}`}`
  return { code: m[1], server }
}

/** ~/<project name>, or ~/<name>-2 … when that folder already holds something. */
export function freeFolder(name: string) {
  const base = join(homedir(), name.replace(/[/\0]/g, '-'))
  for (let i = 1; ; i++) {
    const dir = i === 1 ? base : `${base}-${i}`
    if (!existsSync(dir) || readdirSync(dir).every(f => f === '.DS_Store')) return dir
  }
}

/** Both sides of a conflict as text with git-style markers (or a note for binaries). */
export async function conflictText(p: Project, c: Conflict) {
  const get = async (h: Hash | null) => (h ? ((await call(p, 'GET', `/blobs/${h}`)) as Buffer) : Buffer.alloc(0))
  const [o, a, b] = await Promise.all([get(c.base), get(c.a.hash), get(c.b.hash)])
  if (![o, a, b].every(isText)) return `binary file: A is ${a.length} bytes, B is ${b.length} bytes\n`
  try {
    return merge3(decode(o), decode(a), decode(b), [`A ${c.a.author}`, `B ${c.b.author}`]).text
  } catch {
    return 'too large to show\n'
  }
}

/** Resolves a conflict with the file as it is on this Mac now (e.g. merged by hand). */
export async function keepLocal(p: Project, c: Conflict) {
  const file = join(p.root, c.path)
  const bytes = existsSync(file) ? readFileSync(file) : null
  if (bytes) await call(p, 'PUT', `/blobs/${sha256(bytes)}`, bytes)
  return call(p, 'POST', `/conflicts/${c.id}/resolve`, { hash: bytes && sha256(bytes) })
}

export function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export interface HubOptions {
  server?: string // use this server instead of hosting one here
  port?: number
  sync?: SyncOptions
  discover?: boolean // announce this Mac and list others on the Wi-Fi (Bonjour), default true
}

export class Hub extends EventEmitter {
  readonly state: LocalState
  readonly engines = new Map<string, ProjectSync>()
  readonly logs = new Map<string, string[]>()
  serverUrl = '' // where projects created here live
  hosting?: Server
  hostError?: string
  private opts: HubOptions
  private timer?: NodeJS.Timeout
  private bonjour: ChildProcess[] = []
  /** Other synchacks on this network ("Oliver (MacBook-Air)") → interfaces they were seen on. */
  readonly nearby = new Map<string, Set<string>>()
  private missing = new Set<string>()

  constructor(state: LocalState, opts: HubOptions = {}) {
    super()
    this.state = state
    this.opts = opts
  }

  async start() {
    const pid = Number(this.state.meta('daemon'))
    if (pid && pid !== process.pid && alive(pid)) throw new Error(`synchack is already running (pid ${pid}); stop it first`)
    this.state.setMeta('daemon', String(process.pid))
    if (this.opts.server) this.serverUrl = this.opts.server
    else await this.host(this.opts.port ?? DEFAULT_PORT)
    if (this.opts.discover !== false) this.discover()
    this.tick()
    this.timer = setInterval(() => this.tick(), 1000) // also applies modes set by `synchack pause` etc.
    return this
  }

  private async host(port: number) {
    try {
      this.hosting = await startServer({ port, dataDir: join(this.state.home, 'server') })
      this.serverUrl = this.hosting.url
    } catch {
      // Port taken: fine if it is already a synchack server (e.g. `npm run server`).
      const url = `http://localhost:${port}`
      if (await fetch(`${url}/health`).then(r => r.ok, () => false)) this.serverUrl = url
      else this.hostError = `port ${port} is used by another program; can't host projects`
    }
  }

  private tick() {
    for (const p of this.state.projects()) {
      const sync = this.engines.get(p.id)
      if (sync) {
        if (p.mode !== sync.mode) sync.setMode(p.mode)
        this.state.setStatus(p.id, sync.status())
      } else if (!existsSync(p.root)) {
        if (!this.missing.has(p.id)) this.log(p, `${p.root} is missing; not syncing it`)
        this.missing.add(p.id)
      } else this.add(p)
    }
  }

  private add(p: Project) {
    const sync = new ProjectSync(this.state, p, this.opts.sync)
    sync.on('log', (line: string) => this.log(p, line))
    for (const e of ['status', 'conflict', 'activity']) sync.on(e, () => this.emit('update'))
    this.engines.set(p.id, sync.start())
    return sync
  }

  log(p: Project, line: string) {
    const lines = this.logs.get(p.id) ?? []
    lines.push(`${new Date().toLocaleTimeString()} ${line}`)
    if (lines.length > 200) lines.shift()
    this.logs.set(p.id, lines)
    this.emit('log', p, line)
    this.emit('update')
  }

  /** Shares a folder (existing files are imported) from this Mac. */
  async create(dir: string, name?: string) {
    if (!this.serverUrl) throw new Error(this.hostError ?? 'no server to create projects on')
    const p = await createProject(this.state, this.serverUrl, dir, name)
    this.add(p)
    return p
  }

  /** Joins from an invite; the folder is named after the project unless `dir` is given. */
  async join(invite: string, dir?: string) {
    const { code, server } = parseInvite(invite)
    const p = await joinProject(this.state, server, code, name => dir ?? freeFolder(name))
    this.add(p)
    return p
  }

  /** How this Mac appears to others nearby. */
  get me() {
    const { user, deviceName } = this.state.identity()
    return `${user} (${deviceName})`
  }

  // macOS's own dns-sd tool: announces this Mac and streams others' arrivals and departures.
  private discover() {
    const me = this.me
    const announce = spawn('dns-sd', ['-R', me, '_synchack._tcp', 'local', String(this.hosting?.port ?? DEFAULT_PORT)], { stdio: 'ignore' })
    const browse = spawn('dns-sd', ['-B', '_synchack._tcp'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let rest = ''
    browse.stdout.on('data', (chunk: Buffer) => {
      const lines = (rest + chunk).split('\n')
      rest = lines.pop() ?? ''
      for (const line of lines) {
        // 14:00:23.312  Add  3  14 local.  _synchack._tcp.  Oliver (MacBook-Air)
        const m = line.match(/^\S+\s+(Add|Rmv)\s+\d+\s+(\d+)\s+\S+\s+_synchack\._tcp\.\s+(.+)$/)
        if (!m || m[3] === me) continue
        const seen = this.nearby.get(m[3]) ?? new Set<string>()
        if (m[1] === 'Add') seen.add(m[2])
        else seen.delete(m[2])
        if (seen.size) this.nearby.set(m[3], seen)
        else this.nearby.delete(m[3])
        this.emit('update')
      }
    })
    for (const p of [announce, browse]) p.on('error', () => {}) // no dns-sd: just no discovery
    this.bonjour = [announce, browse]
  }

  async close() {
    clearInterval(this.timer)
    for (const p of this.bonjour) p.kill()
    await Promise.all([...this.engines.values()].map(e => e.stop()))
    await this.hosting?.close()
    this.state.setMeta('daemon', '')
  }
}
