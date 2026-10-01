// The background half of synchack: syncs every project on this Mac and hosts the ones
// created here. Used by the terminal UI and by `synchack run`.
import { EventEmitter } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { startServer, type Server } from '../server/server.ts'
import { lanAddresses, sha256, type Conflict, type Hash } from '../shared/protocol.ts'
import { decode, isText, merge3 } from '../shared/merge.ts'
import { cleanPath } from '../shared/paths.ts'
import { ProjectSync, call, createProject, joinProject, type SyncOptions } from './engine.ts'
import type { LocalState, Project } from './state.ts'
import { hostIdentity, pinOf, request, urlPin } from './net.ts'

export const DEFAULT_PORT = 8787
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]']

/**
 * "HX7-K92@192.168.1.129:8787#k3Jq…": everything a teammate needs, in one paste. The part after
 * `#` is the hash of the host's public key: joining checks it before sending anything.
 */
export function inviteFor(p: Pick<Project, 'code' | 'server'> & { cert?: string | null }) {
  const u = new URL(p.server)
  if (u.protocol === 'https:' && !p.cert) return `${p.code}@${u.origin}` // a CA-signed server
  const host = LOOPBACK.includes(u.hostname) ? (lanAddresses()[0] ?? u.hostname) : u.hostname
  return `${p.code}@${host}:${u.port || DEFAULT_PORT}${p.cert ? `#${urlPin(pinOf(p.cert))}` : ''}`
}

export function parseInvite(invite: string) {
  const m = invite.trim().match(/^([A-Za-z0-9]{3}-?[A-Za-z0-9]{3})@([^\s#]+)(?:#([\w+/=-]{43,44}))?$/)
  if (!m) throw new Error('an invite looks like HX7-K92@192.168.1.129:8787#k3Jq…')
  const addr = m[2].replace(/\/+$/, '')
  const pin = m[3]
  const scheme = pin ? 'https' : 'http'
  const server = /^https?:\/\//.test(addr) ? addr : `${scheme}://${addr.includes(':') ? addr : `${addr}:${DEFAULT_PORT}`}`
  return { code: m[1], server, pin }
}

/** The shell command that installs synchack from a hosting Mac, pinned to its key when it has one. */
export function installCommand(port: number, cert?: string) {
  const host = lanAddresses()[0] ?? 'localhost'
  return cert ? `curl -fsSLk --pinnedpubkey sha256//${pinOf(cert)} https://${host}:${port}/install | sh` : `curl -fsSL http://${host}:${port}/install | sh`
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

/**
 * The project's current invite. Invites expire, so this asks the server (which replaces an
 * expired code, or any code when `rotate`) and remembers the answer here.
 */
export async function refreshInvite(state: LocalState, p: Project, rotate = false) {
  const { code } = await call(p, 'POST', '/invite', { rotate })
  state.setCode(p.id, code)
  p.code = code
  return inviteFor(p)
}

/** Removes a teammate (creator only) or this device. Removing someone also replaces the invite. */
export async function removeMember(state: LocalState, p: Project, device: string) {
  const { invite } = await call(p, 'DELETE', `/members/${encodeURIComponent(device)}`)
  if (device === state.device) state.removeProject(p.id)
  else if (invite) {
    state.setCode(p.id, invite.code)
    p.code = invite.code
  }
}

/**
 * Brings back files missing from this Mac under `prefix` ('' = the whole project): each gets
 * the server's current content or, if it was deleted there, its last content. With `version`,
 * writes that version of the one file `prefix` names (replacing a local file only with `force`).
 * Restored files are ordinary local edits: sync uploads them as new versions.
 */
export async function restore(p: Project, prefix = '', opts: { version?: number; force?: boolean } = {}) {
  const root = realpathSync(p.root)
  const under = (path: string) => !prefix || path === prefix || path.startsWith(prefix.replace(/\/$/, '') + '/')
  const last = async (path: string, version?: number) => {
    const { versions } = (await call(p, 'GET', `/history?path=${encodeURIComponent(path)}`)) as { versions: { version: number; hash: Hash | null }[] }
    const v = version === undefined ? versions.findLast(v => v.hash) : versions.find(v => v.version === version)
    if (version !== undefined && !v) throw new Error(`${path} has no version ${version}`)
    return v?.hash ?? null
  }
  const write = async (path: string, hash: Hash) => {
    const file = join(root, cleanPath(path))
    mkdirSync(dirname(file), { recursive: true })
    const real = realpathSync(dirname(file))
    if (real !== root && !real.startsWith(root + sep)) throw new Error(`${path} resolves outside the project folder`)
    const bytes = (await call(p, 'GET', `/blobs/${hash}`)) as Buffer
    if (sha256(bytes) !== hash) throw new Error(`download of ${path} was corrupted`)
    writeFileSync(file, bytes)
  }
  if (opts.version !== undefined) {
    const path = cleanPath(prefix)
    if (existsSync(join(root, path)) && !opts.force) throw new Error(`${path} exists on this Mac; pass --force to replace it`)
    const hash = await last(path, opts.version)
    if (!hash) throw new Error(`version ${opts.version} of ${path} is a deletion`)
    await write(path, hash)
    return [path]
  }
  const { heads } = (await call(p, 'GET', '/heads')) as { heads: { path: string; hash: Hash | null }[] }
  const restored: string[] = []
  for (const h of heads) {
    if (!under(h.path) || existsSync(join(root, h.path))) continue
    const hash = h.hash ?? (await last(h.path))
    if (!hash) continue
    await write(h.path, hash)
    restored.push(h.path)
  }
  return restored
}

/** Resolves a conflict with the file as it is on this Mac now (e.g. merged by hand). */
export async function keepLocal(p: Project, c: Conflict) {
  const file = join(p.root, c.path)
  const bytes = existsSync(file) ? readFileSync(file) : null
  if (bytes) await call(p, 'PUT', `/blobs/${sha256(bytes)}`, bytes)
  return call(p, 'POST', `/conflicts/${c.id}/resolve`, { hash: bytes && sha256(bytes) })
}

/** Appends the hosted server's log lines to `file`, keeping it and one older file of up to 5 MB each. */
function serverLog(file: string) {
  return (line: string) => {
    try {
      if (existsSync(file) && statSync(file).size > 5 * 1024 * 1024) renameSync(file, `${file}.1`)
      appendFileSync(file, `${new Date().toISOString()} ${line}\n`)
    } catch {} // logging must never break hosting
  }
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
  serverCert: string | null = null // its self-signed certificate, when this Mac hosts with TLS
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
    const tls = hostIdentity(join(this.state.home, 'tls'))
    try {
      this.hosting = await startServer({ port, dataDir: join(this.state.home, 'server'), localCreateOnly: true, log: serverLog(join(this.state.home, 'server.log')), tls })
      this.serverUrl = this.hosting.url
      this.serverCert = tls?.cert ?? null
    } catch {
      // Port taken: fine if it is already a synchack server (e.g. `npm run server`, or another synchack here).
      for (const peer of [{ server: `https://localhost:${port}`, cert: tls?.cert }, { server: `http://localhost:${port}` }]) {
        if (peer.server.startsWith('https') && !peer.cert) continue
        const res = await request(peer, 'GET', '/health', { timeoutMs: 2000 }).catch(() => undefined)
        if (res?.status !== 200) continue
        this.serverUrl = peer.server
        this.serverCert = peer.cert ?? null
        return
      }
      this.hostError = `port ${port} is used by another program; can't host projects`
    }
  }

  private tick() {
    const projects = this.state.projects()
    for (const [id, sync] of this.engines) // left with `synchack leave`
      if (!projects.some(p => p.id === id)) {
        this.engines.delete(id)
        void sync.stop()
        this.emit('update')
      }
    for (const p of projects) {
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
    const p = await createProject(this.state, this.serverUrl, dir, name, this.serverCert)
    this.add(p)
    return p
  }

  /** Joins from an invite; the folder is named after the project unless `dir` is given. */
  async join(invite: string, dir?: string) {
    const { code, server, pin } = parseInvite(invite)
    const p = await joinProject(this.state, server, code, name => dir ?? freeFolder(name), pin)
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
