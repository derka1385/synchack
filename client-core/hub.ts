// The background half of synchack: syncs every project on this Mac and hosts the ones
// created here. Used by the terminal UI and by `synchack run`.
import { EventEmitter } from 'node:events'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { startServer, type Inbound, type Server } from '../server/server.ts'
import { MAX_FILE, lanAddresses, sha256, type Conflict, type Hash } from '../shared/protocol.ts'
import { decode, isText, merge3 } from '../shared/merge.ts'
import { cleanPath, ignoreRules, printable, secret, within } from '../shared/paths.ts'
import { ProjectSync, call, createProject, joinProject, type SyncOptions } from './engine.ts'
import type { LocalState, Project } from './state.ts'
import { hostIdentity, pinOf, pinnedCert, request, stdPin, urlPin } from './net.ts'

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
  const m = invite.trim().match(/^([A-Za-z0-9]{4}-?[A-Za-z0-9]{4}|[A-Za-z0-9]{3}-?[A-Za-z0-9]{3})@([^\s#]+)(?:#([\w+/=-]{43,44}))?$/)
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

/** Throws if `file` exists and is not a regular file (a symlink could point anywhere on this Mac). */
function regularOrAbsent(file: string) {
  let st
  try {
    st = lstatSync(file)
  } catch {
    return
  }
  if (!st.isFile()) throw new Error(`${file} is a symlink or not a regular file; not touching it`)
}

/** Writes a file by renaming a temp file over it: never follows a symlink at `file`. */
function replaceFile(file: string, bytes: Uint8Array | string) {
  regularOrAbsent(file)
  const tmp = `${dirname(file)}/.synchack-${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, bytes, { flag: 'wx' })
    renameSync(tmp, file)
  } finally {
    rmSync(tmp, { force: true })
  }
}

/**
 * ~/<project name>, or ~/<name>-2 … when that name is taken. The name comes from the creator's
 * Mac, so it is reduced to one plain, visible folder name first (never "..", "~/.ssh", a path or
 * "Tools.app"): letters, digits, spaces, "_" and "-" only.
 */
export function freeFolder(name: string) {
  const safe = printable(name).normalize('NFC').replace(/[^\p{L}\p{N} _-]+/gu, '-').replace(/^[-\s]+|[-\s]+$/g, '').slice(0, 80) || 'project'
  const base = join(homedir(), safe)
  for (let i = 1; ; i++) {
    const dir = i === 1 ? base : `${base}-${i}`
    if (!existsSync(dir)) return dir
    if (statSync(dir).isDirectory() && readdirSync(dir).every(f => f === '.DS_Store')) return dir
  }
}

export interface SharePreview {
  files: number
  bytes: number
  secrets: string[] // .env, keys: never leave this Mac
  skipped: string[] // ignored folders and files (top level of each)
  tooBig: string[] // over 100 MB, not synced
  git: boolean
  truncated?: boolean // stopped counting: far too many entries for a project
}

const PREVIEW_LIMIT = 20_000 // entries visited before the preview gives up (a home folder has millions)

/** What sharing an existing folder would send, and what stays on this Mac. Reads only. */
export function previewShare(dir: string): SharePreview {
  let rules = ''
  try {
    rules = readFileSync(join(dir, '.synchackignore'), 'utf8')
  } catch {}
  const ignored = ignoreRules(rules)
  const out: SharePreview = { files: 0, bytes: 0, secrets: [], skipped: [], tooBig: [], git: existsSync(join(dir, '.git')) }
  let visited = 0
  const walk = (rel: string) => {
    if (out.truncated) return
    let entries
    try {
      entries = readdirSync(join(dir, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (++visited > PREVIEW_LIMIT) return void (out.truncated = true)
      const path = (rel ? rel + '/' : '') + e.name.normalize('NFC')
      const isDir = e.isDirectory()
      if (!isDir && !e.isFile()) continue
      if (ignored(path, isDir)) {
        if (['.ds_store', '.git', '.synchack'].includes(e.name.toLowerCase())) continue
        ;(secret(path) ? out.secrets : out.skipped).push(isDir ? `${path}/` : path)
      } else if (isDir) walk(path)
      else {
        const size = statSync(join(dir, path)).size
        if (size > MAX_FILE) out.tooBig.push(path)
        else (out.files++, (out.bytes += size))
      }
    }
  }
  walk('')
  return out
}

/** The preview as short lines, tagged so the UI can colour them. */
export function previewLines(x: SharePreview): ['ok' | 'safe' | 'skip' | 'info' | 'warn', string][] {
  const size = x.bytes < 1e6 ? `${Math.max(1, Math.round(x.bytes / 1e3))} KB` : `${(x.bytes / 1e6).toFixed(1)} MB`
  const groups = new Map<string, number>() // "__pycache__/" ×18 rather than 18 lines
  for (const s of x.skipped) {
    const name = `${s.split('/').filter(Boolean).pop()}${s.endsWith('/') ? '/' : ''}`
    groups.set(name, (groups.get(name) ?? 0) + 1)
  }
  const lines: ReturnType<typeof previewLines> = [['ok', `${x.files} file${x.files === 1 ? '' : 's'} (${size}) will be shared with everyone you invite`]]
  if (x.secrets.length) lines.push(['safe', `stays on this Mac: ${x.secrets.join(', ')} (secrets never leave)`])
  if (groups.size) lines.push(['skip', `not shared: ${[...groups].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join('  ')}`])
  if (x.git) lines.push(['info', 'git repo: teammates get the files, not the history (.git/). You keep committing from this Mac.'])
  if (x.tooBig.length) lines.push(['warn', `over 100 MB, not shared: ${x.tooBig.join(', ')}`])
  if (x.truncated) lines.push(['warn', `stopped counting after ${PREVIEW_LIMIT.toLocaleString('en')} entries: this looks like much more than one project`])
  if (x.files > 3000) lines.push(['warn', `${x.files} files is a lot for live sync: exclude build or data folders in .synchackignore first`])
  return lines
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
    if (!within(root, realpathSync(dirname(file)))) throw new Error(`${path} resolves outside the project folder`)
    const bytes = (await call(p, 'GET', `/blobs/${hash}`)) as Buffer
    if (sha256(bytes) !== hash) throw new Error(`download of ${path} was corrupted`)
    replaceFile(file, bytes)
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
    try {
      cleanPath(h.path)
    } catch {
      continue
    }
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
  const root = realpathSync(p.root)
  const file = join(root, cleanPath(c.path))
  const st = lstatSync(file, { throwIfNoEntry: false })
  // only a regular file that really is inside the project: never one behind a symlink
  if (st && (!st.isFile() || !within(root, realpathSync(file)))) throw new Error(`${c.path} is not a plain file inside the project`)
  const bytes = st ? readFileSync(file) : null
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

/** A `dns-sd -B` result: "14:00:23.312  Add  3  14 local.  _synchack._tcp.  Oliver (MacBook-Air)"; before 10:00 the time starts with a space. */
export const BROWSE_LINE = /^\s*\S+\s+(Add|Rmv)\s+\d+\s+(\d+)\s+\S+\s+_synchack\._tcp\.\s+(.+)$/

/** Whether pid is a running synchack: one that was killed leaves its pid behind, and macOS reuses pids. */
export function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return /synchack|client-core\/cli/i.test(execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }))
  } catch {
    return false
  }
}

// ── sharing choices and files, for the interfaces ────────────────────────

export interface Entry {
  name: string
  path: string
  dir: boolean
  shared: boolean // false: stays on this Mac (ignored)
  secret: boolean // .env, keys: never shared, whatever the toggle says
}

const ignoreText = (root: string) => {
  try {
    return readFileSync(join(root, '.synchackignore'), 'utf8')
  } catch {
    return ''
  }
}

/** One folder level of a project (or a folder about to be shared), with what is shared. */
export function listFiles(root: string, dir = ''): Entry[] {
  const ignored = ignoreRules(ignoreText(root))
  const base = dir ? cleanPath(dir) : ''
  return readdirSync(join(root, base), { withFileTypes: true })
    .filter(e => (e.isFile() || e.isDirectory()) && !['.DS_Store', '.git', '.synchack'].includes(e.name))
    .map(e => {
      const path = (base ? base + '/' : '') + e.name.normalize('NFC')
      return { name: e.name.normalize('NFC'), path, dir: e.isDirectory(), shared: !ignored(path, e.isDirectory()), secret: secret(path) }
    })
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
}

/**
 * Shares or keeps one file/folder on this Mac by editing .synchackignore at the root. The file
 * syncs, so the choice applies to the whole team. Secrets can never be shared.
 */
export function setShared(root: string, path: string, dir: boolean, shared: boolean) {
  const clean = cleanPath(path)
  if (shared && secret(clean)) throw new Error('secrets (.env, keys) always stay on each Mac')
  regularOrAbsent(join(root, '.synchackignore'))
  const rule = `/${clean}${dir ? '/' : ''}`
  const lines = ignoreText(root).split('\n').filter(l => l.trim() !== rule && l.trim() !== `!${rule}`)
  let text = lines.join('\n').replace(/\n+$/, '')
  if (ignoreRules(text)(clean, dir) === shared) text += `${text ? '\n' : ''}${shared ? '!' : ''}${rule}`
  replaceFile(join(root, '.synchackignore'), text ? text + '\n' : '')
  if (ignoreRules(text)(clean, dir) === shared) throw new Error(`${clean} is inside a folder that stays on this Mac; share that folder first`)
}

/** Creates a file in a project (missing folders included). Sync picks it up like any edit. */
export function addFile(root: string, path: string, content: Uint8Array | string = '') {
  const clean = cleanPath(path)
  const file = join(root, clean)
  if (existsSync(file)) throw new Error(`${clean} already exists`)
  mkdirSync(dirname(file), { recursive: true })
  const real = realpathSync(dirname(file))
  if (real !== realpathSync(root) && !real.startsWith(realpathSync(root) + sep)) throw new Error(`${clean} resolves outside the project folder`)
  writeFileSync(file, content, { flag: 'wx' })
  return clean
}

// ── invitations between Macs ─────────────────────────────────────────────

export interface Invitation extends Inbound {
  id: string
  at: number
}

const codeKey = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '')
// scrypt makes guessing the code from an intercepted invitation slow (about 50 ms a guess)
const bind = (code: string, i: Pick<Inbound, 'salt' | 'address' | 'pin' | 'project'>) =>
  scryptSync(codeKey(code), `${i.salt}|${i.address}|${i.pin ?? ''}|${i.project}`, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })

/** Where a nearby synchack listens, from its Bonjour record: host:port and TLS key pin. */
function resolvePeer(instance: string): Promise<{ address: string; pin?: string }> {
  return new Promise((ok, fail) => {
    const p = spawn('dns-sd', ['-L', instance, '_synchack._tcp', 'local'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    const done = (e?: Error) => {
      clearTimeout(timer)
      p.kill()
      const at = out.match(/can be reached at (\S+?)\.?:(\d+)/)
      if (at) ok({ address: `${at[1]}:${at[2]}`, pin: out.match(/\bpin=([\w-]{43})/)?.[1] })
      else fail(e ?? new Error(`${instance} did not answer; are you on the same network?`))
    }
    const timer = setTimeout(() => done(), 4000)
    p.stdout.on('data', (d: Buffer) => {
      out += d
      if (/can be reached at/.test(out) && /\bpin=|\n\s*$/.test(out)) setTimeout(() => done(), 150) // the TXT line follows
    })
    p.on('error', e => done(e))
  })
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
  /** Invitations other Macs pushed here, waiting for the code. */
  readonly inbox: Invitation[] = []

  constructor(state: LocalState, opts: HubOptions = {}) {
    super()
    this.state = state
    this.opts = opts
  }

  async start() {
    const pid = Number(this.state.meta('daemon'))
    if (pid && pid !== process.pid && alive(pid)) throw new Error(`synchack is already running (pid ${pid}). Stop it with: synchack stop`)
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
      this.hosting = await startServer({ port, dataDir: join(this.state.home, 'server'), localCreateOnly: true, log: serverLog(join(this.state.home, 'server.log')), tls, inbox: i => this.received(i) })
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
    const txt = this.serverCert && this.hosting ? [`pin=${urlPin(pinOf(this.serverCert))}`] : []
    const announce = spawn('dns-sd', ['-R', me, '_synchack._tcp', 'local', String(this.hosting?.port ?? DEFAULT_PORT), ...txt], { stdio: 'ignore' })
    const browse = spawn('dns-sd', ['-B', '_synchack._tcp'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let rest = ''
    browse.stdout.on('data', (chunk: Buffer) => {
      const lines = (rest + chunk).split('\n')
      rest = lines.pop() ?? ''
      for (const line of lines) {
        const m = line.match(BROWSE_LINE)
        if (!m || m[3].replace(/ \(\d+\)$/, '') === me || m[3].length > 120 || printable(m[3]) !== m[3]) continue // ourselves (maybe renamed "(2)"), or a hostile name
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

  /**
   * Anyone on the network can post an invitation (a forged one can never be joined: see bind()).
   * So a sender may only replace its own: a resent invitation from the same address replaces the
   * old one, another address can't push it out, and one address keeps at most 3 cards here.
   */
  private received(i: Inbound) {
    if (this.inbox.some(x => x.mac === i.mac)) return // the same invitation twice
    const same = this.inbox.findIndex(x => x.source === i.source && x.from === i.from && x.project === i.project)
    if (same >= 0) this.inbox.splice(same, 1)
    const mine = this.inbox.filter(x => x.source === i.source)
    if (mine.length >= 3) this.inbox.splice(this.inbox.indexOf(mine[0]), 1)
    this.inbox.push({ ...i, id: randomBytes(6).toString('hex'), at: Date.now() })
    if (this.inbox.length > 20) this.inbox.shift()
    this.emit('invitation')
    this.emit('update')
  }

  /**
   * Pushes an invitation to a nearby synchack ("Oliver (MacBook-Air)"). Returns the code to tell
   * them: their synchack asks for it, and it only joins if the code matches this invitation.
   */
  async invite(projectId: string, peer: string) {
    const p = this.state.project(projectId)
    if (!p) throw new Error('no such project')
    if (!this.nearby.has(peer)) throw new Error(`${peer} is not nearby (not on this network right now)`)
    const { code, pin } = parseInvite(await refreshInvite(this.state, p))
    const address = inviteFor(p).split('@')[1].split('#')[0]
    const salt = randomBytes(16).toString('hex')
    const body = JSON.stringify({ from: this.me, project: p.name, address, pin: pin ?? null, salt, mac: bind(code, { salt, address, pin: pin ?? null, project: p.name }).toString('hex') })
    const them = await resolvePeer(peer)
    const server = `${them.pin ? 'https' : 'http'}://${them.address}`
    const cert = them.pin ? await pinnedCert(server, stdPin(them.pin)) : undefined
    const res = await request({ server, cert }, 'POST', '/inbox', { headers: { 'content-type': 'application/json' }, body, timeoutMs: 5000 })
    if (res.status !== 204) throw new Error(`${peer} refused the invitation (${res.status})`)
    return code
  }

  /** Joins an invitation from the inbox, if `code` is the one shown on the inviter's screen. */
  async accept(id: string, code: string, dir?: string) {
    const i = this.inbox.find(x => x.id === id)
    if (!i) throw new Error('that invitation is gone')
    if (!timingSafeEqual(bind(code, i), Buffer.from(i.mac, 'hex'))) throw new Error(`wrong code: type the one on ${i.from.replace(/ \(.*\)$/, '')}'s screen`)
    const p = await this.join(`${codeKey(code)}@${i.address}${i.pin ? `#${i.pin}` : ''}`, dir)
    this.dismiss(id)
    return p
  }

  dismiss(id: string) {
    const at = this.inbox.findIndex(x => x.id === id)
    if (at >= 0) this.inbox.splice(at, 1)
    this.emit('update')
  }

  private closing?: Promise<void>
  /** Safe to call more than once (the terminal view, a signal and the CLI may all ask). */
  close() {
    return (this.closing ??= (async () => {
      clearInterval(this.timer)
      for (const p of this.bonjour) p.kill()
      await Promise.all([...this.engines.values()].map(e => e.stop()))
      await this.hosting?.close()
      this.state.setMeta('daemon', '')
    })())
  }
}
