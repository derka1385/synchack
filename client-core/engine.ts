// Keeps one local folder in sync with the server. One ProjectSync per shared project.
//
// The whole algorithm rests on one invariant. For every path, the local `files` row holds the
// server version and content hash this file was last in sync with:
//   disk == row.hash  → clean: a newer remote version may overwrite it.
//   disk != row.hash  → local edits: upload them with baseHash = row.hash, the server merges.
// When we write a remote file we record its hash before the watcher reports the write, so
// the echo hashes equal and nothing is uploaded: content hashes, not timers, stop loops.
// Remote events older than the row's version are ignored, so duplicates are harmless.

import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { link, lstat, mkdir, readdir, readFile, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import { MAX_FILE, sha256, type Conflict, type Hash, type Head, type Member, type Mode, type Op, type OpResult, type ServerMsg } from '../shared/protocol.ts'
import { cleanPath, ignoreRules, type Ignore } from '../shared/paths.ts'
import type { LocalState, Project } from './state.ts'

/** Server unreachable or failing: retried later, never mistaken for a local file problem. */
export class NetError extends Error {}

type Target = Pick<Project, 'server' | 'id' | 'token'>

/** Authenticated call to a project's API. JSON in and out; Uint8Array bodies go raw. */
export async function call(p: Target, method: string, path: string, body?: unknown): Promise<any> {
  const raw = body instanceof Uint8Array
  let res: Response
  try {
    res = await fetch(`${p.server}/api/p/${p.id}${path}`, {
      method,
      headers: { authorization: `Bearer ${p.token}`, ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : raw ? (body as Uint8Array<ArrayBuffer>) : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    })
  } catch (e) {
    throw new NetError(`${method} ${path}: ${(e as Error).message}`)
  }
  if (!res.ok) throw new NetError(`${method} ${path}: ${res.status} ${await res.text()}`)
  if (res.status === 204) return undefined
  return res.headers.get('content-type')?.startsWith('application/json') ? res.json() : Buffer.from(await res.arrayBuffer())
}

async function post(server: string, path: string, body: unknown) {
  let res: Response
  try {
    res = await fetch(server + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  } catch {
    throw new Error(`can't reach the sync server at ${server}. Is it running, and is --server its address? ("localhost" is the Mac you type it on.)`)
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `${path}: HTTP ${res.status}`)
  return data
}

function claim(state: LocalState, dir: string) {
  mkdirSync(dir, { recursive: true })
  const root = realpathSync(dir)
  const clash = state.projects().find(p => root === p.root || root.startsWith(p.root + sep) || p.root.startsWith(root + sep))
  if (clash) throw new Error(`${root} overlaps the shared folder ${clash.root}`)
  return root
}

/** Registers a new shared project. Existing files in `dir` are imported on the first sync. */
export async function createProject(state: LocalState, server: string, dir: string, name = basename(dir)) {
  const root = claim(state, dir)
  const r = await post(server, '/api/projects', { name, ...state.identity() })
  const p: Project = { id: r.projectId, name: r.name, root, server, token: r.token, code: r.code, mode: 'live', seq: 0 }
  state.addProject(p)
  return p
}

/** Registers an existing project by join code. `dir` may depend on the project's name. Files arrive on the first sync. */
export async function joinProject(state: LocalState, server: string, code: string, dir: string | ((name: string) => string)) {
  const r = await post(server, '/api/join', { code, ...state.identity() })
  const root = claim(state, typeof dir === 'string' ? dir : dir(r.name))
  const p: Project = { id: r.projectId, name: r.name, root, server, token: r.token, code: r.code, mode: 'live', seq: 0 }
  state.addProject(p)
  return p
}

export interface SyncOptions {
  liveMs?: number // debounce after the last event on a file
  calmMs?: number
  reconnectMaxMs?: number
}

const REMOVED = 4001 // WebSocket close code: this device was removed from the project
const BATCH_FILES = 500
const BATCH_BYTES = 32 * 1024 * 1024

export class ProjectSync extends EventEmitter {
  readonly p: Project
  readonly root: string
  readonly state: LocalState
  readonly opts: Required<SyncOptions>
  mode: Mode
  online = false
  members: Member[] = []
  conflicts = new Map<string, Conflict>()
  errors = new Map<string, string>()
  stats = { ops: 0, uploads: 0, downloads: 0, lastSync: 0 }
  /** Last change to each path, by whom: shows who is working on which file. */
  activity = new Map<string, { device: string; author: string | null; at: number; deleted: boolean }>()

  private ignored: Ignore = ignoreRules()
  private ignoreText?: string
  private ws?: WebSocket
  private watcher?: FSWatcher
  private timers = new Map<string, NodeJS.Timeout>() // per-file debounce
  private ready = new Set<string>() // debounced, waiting for the next flush
  private stale = new Set<string>() // server has newer content we could not apply over local edits
  private blocked = new Set<string>() // open conflict: uploads held until it is resolved
  private scanned = new Map<string, { size: number; mtimeMs: number; hash: Hash }>()
  private prefetched = new Map<Hash, Buffer>()
  private queue: Promise<void> = Promise.resolve() // every sync step runs here, one at a time
  private flushQueued = false
  private backoff = 0
  private lastMsg = 0
  private stopped = false
  private reconnect?: NodeJS.Timeout
  private heartbeat?: NodeJS.Timeout

  constructor(state: LocalState, p: Project, opts: SyncOptions = {}) {
    super()
    this.state = state
    this.p = p
    this.root = realpathSync(p.root)
    this.mode = p.mode
    this.opts = { liveMs: 400, calmMs: 15_000, reconnectMaxMs: 10_000, ...opts }
  }

  start() {
    const meta = join(this.root, '.synchack')
    rmSync(join(meta, 'tmp'), { recursive: true, force: true })
    mkdirSync(join(meta, 'tmp'), { recursive: true })
    writeFileSync(join(meta, '.gitignore'), '*\n') // keeps our temp files out of git
    this.loadIgnore()
    this.watcher = watch(this.root, { recursive: true }, (_, f) => (f ? this.touch(f.normalize('NFC')) : this.rescan()))
    this.watcher.on('error', e => this.log(`watcher: ${e.message}`))
    this.heartbeat = setInterval(() => {
      if (this.ws && Date.now() - this.lastMsg > 60_000) this.drop(this.ws) // silent socket: server gone
    }, 15_000)
    this.connect()
    return this
  }

  async stop() {
    if (this.online) {
      for (const [path, t] of this.timers) clearTimeout(t), this.ready.add(path) // flush what is pending
      this.timers.clear()
      this.kick()
    }
    await this.settled()
    this.stopped = true
    this.watcher?.close()
    for (const t of this.timers.values()) clearTimeout(t)
    clearTimeout(this.reconnect)
    clearInterval(this.heartbeat)
    if (this.ws) this.drop(this.ws)
    await this.settled()
  }

  setMode(mode: Mode) {
    if (mode === this.mode) return
    const was = this.mode
    this.mode = this.p.mode = mode
    this.state.setMode(this.p.id, mode)
    if (mode === 'paused') this.ws && this.drop(this.ws) // local edits pile up; reconciled on resume
    else if (was === 'paused') this.connect()
    else for (const path of [...this.timers.keys()]) this.touch(path) // re-arm with the new delay
    this.log(`mode: ${mode}`)
    this.emit('status')
  }

  /** Resolves once connected with nothing left to upload. */
  async idle(timeoutMs = 20_000) {
    const end = Date.now() + timeoutMs
    for (;;) {
      await this.settled()
      if (this.online && !this.timers.size && !this.ready.size) return
      if (Date.now() > end) throw new Error(`${this.p.name}: still syncing after ${timeoutMs} ms`)
      await new Promise(r => setTimeout(r, 20))
    }
  }

  status() {
    return {
      id: this.p.id,
      name: this.p.name,
      root: this.root,
      code: this.p.code,
      mode: this.mode,
      online: this.online,
      pending: this.timers.size + this.ready.size,
      conflicts: [...this.conflicts.values()],
      members: this.members,
      errors: Object.fromEntries(this.errors),
      stats: this.stats,
      at: Date.now(),
    }
  }

  // ── local side ──────────────────────────────────────────────────────────

  private touch(path: string, ms = this.mode === 'calm' ? this.opts.calmMs : this.opts.liveMs) {
    if (this.stopped) return
    if (path === '.synchackignore') this.loadIgnore()
    if (this.ignored(path)) return
    clearTimeout(this.timers.get(path))
    this.timers.set(
      path,
      setTimeout(() => {
        this.timers.delete(path)
        this.ready.add(path)
        this.kick()
      }, ms),
    )
  }

  private loadIgnore() {
    let text = ''
    try {
      text = readFileSync(join(this.root, '.synchackignore'), 'utf8')
    } catch {}
    if (text === this.ignoreText) return
    this.ignoreText = text
    this.ignored = ignoreRules(text)
    if (!this.watcher) return
    // Files the new rules stop ignoring: ours to upload, and the server's, which we skipped
    // while still ignoring them (they can arrive before the new .synchackignore does).
    this.rescan()
    this.enqueue(async () => {
      if (this.online) await this.pull((await this.api('GET', '/heads')).heads)
    })
  }

  private rescan() {
    this.enqueue(() => this.fullScan())
  }

  private enqueue(task: () => Promise<void>) {
    this.queue = this.queue.then(task).catch(e => this.log(`error: ${(e as Error).message}`))
  }

  private async settled() {
    let q
    do await (q = this.queue)
    while (q !== this.queue)
  }

  private kick() {
    if (this.flushQueued || !this.online || this.mode === 'paused' || !this.ready.size) return
    this.flushQueued = true
    this.enqueue(async () => {
      this.flushQueued = false
      await this.flush()
    })
  }

  /** Marks every file that differs from its last synced state (startup, reconnect, resume). */
  private async fullScan() {
    if (!existsSync(this.root)) return this.fail('', 'project folder is missing; sync stopped')
    const files = await this.walk('')
    const present = new Set(files)
    for (const path of this.state.tracked(this.p.id)) if (!present.has(path) && !this.ignored(path)) this.ready.add(path)
    for (const path of files) {
      const seen = this.scanned.get(path)
      const st = await lstat(join(this.root, path)).catch(() => undefined)
      const same = seen && st && seen.size === st.size && seen.mtimeMs === st.mtimeMs && seen.hash === this.state.file(this.p.id, path).hash
      if (!same) this.ready.add(path)
    }
    for (const path of this.stale) this.ready.add(path)
    this.kick()
  }

  private async walk(dir: string): Promise<string[]> {
    const out: string[] = []
    const entries = await readdir(join(this.root, dir), { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      const path = (dir ? dir + '/' : '') + e.name.normalize('NFC')
      if (e.isDirectory()) {
        if (!this.ignored(path, true)) out.push(...(await this.walk(path)))
      } else if (e.isFile() && !this.ignored(path)) out.push(path)
    }
    return out
  }

  /** FSEvents reports a moved or deleted folder once: it stands for everything under it. */
  private async expand(paths: string[]) {
    const out = new Set<string>()
    for (const path of paths) {
      out.add(path) // a tracked file that became a folder (or vanished) reads as deleted
      const st = await lstat(join(this.root, path)).catch(() => undefined)
      if (st?.isDirectory() && !this.ignored(path, true)) for (const f of await this.walk(path)) out.add(f)
      for (const f of this.state.tracked(this.p.id, path + '/')) out.add(f)
    }
    return [...out].filter(p => !this.ignored(p))
  }

  /** Current content, or null when there is no regular file at exactly this path. */
  private async read(path: string): Promise<{ hash: Hash; bytes: Buffer } | null> {
    const abs = join(this.root, path)
    try {
      const st = await lstat(abs)
      if (!st.isFile()) return null
      if (st.size > MAX_FILE) throw new Error('larger than 100 MB, not synced')
      // APFS ignores case: "readme.md" must not be read through a file named "README.md"
      if (basename(await realpath(abs)).normalize('NFC') !== basename(path)) return null
      const bytes = await readFile(abs)
      const hash = sha256(bytes)
      this.scanned.set(path, { size: st.size, mtimeMs: st.mtimeMs, hash }) // stat taken before the read
      return { hash, bytes }
    } catch (e) {
      if (['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) return null
      throw e
    }
  }

  // ── upload ──────────────────────────────────────────────────────────────

  private async flush() {
    // A vanished root (moved folder, unplugged disk) must never read as "everything was deleted".
    if (!existsSync(this.root)) return this.fail('', 'project folder is missing; sync stopped')
    while (this.ready.size && this.online && this.mode !== 'paused') {
      const batch = [...this.ready].slice(0, BATCH_FILES)
      for (const path of batch) this.ready.delete(path)
      const files = await this.expand(batch)
      const ops: Op[] = []
      const blobs = new Map<Hash, Buffer>()
      let bytes = 0
      for (const path of files) {
        if (bytes > BATCH_BYTES) {
          this.ready.add(path)
          continue
        }
        if (this.blocked.has(path)) continue // picked up again when the conflict is resolved
        let disk
        try {
          disk = await this.read(path)
        } catch (e) {
          this.fail(path, e)
          continue
        }
        const st = this.state.file(this.p.id, path)
        const hash = disk?.hash ?? null
        if (hash === st.hash && !this.stale.has(path)) continue
        if (disk) {
          blobs.set(disk.hash, disk.bytes)
          bytes += disk.bytes.length
        }
        const opId = sha256(`${this.state.device}\n${path}\n${st.version}\n${st.hash}\n${hash}`)
        ops.push({ opId, path, baseVersion: st.version, baseHash: st.hash, hash })
      }
      ops.sort((x, y) => Number(x.hash !== null) - Number(y.hash !== null)) // deletes first (case-only renames)
      if (!existsSync(this.root)) return this.fail('', 'project folder is missing; sync stopped') // moved mid-flush
      try {
        if (ops.length) await this.push(ops, blobs)
      } catch (e) {
        for (const op of ops) this.ready.add(op.path)
        this.log(`upload failed, retrying: ${(e as Error).message}`)
        setTimeout(() => this.kick(), 2000).unref()
        return
      }
    }
  }

  private async push(ops: Op[], blobs: Map<Hash, Buffer>) {
    if (blobs.size) {
      const { missing } = await this.api('POST', '/blobs/missing', { hashes: [...blobs.keys()] })
      await pool(missing as Hash[], 8, async h => {
        await this.api('PUT', `/blobs/${h}`, blobs.get(h))
        this.stats.uploads++
      })
    }
    const { results } = (await this.api('POST', '/ops', { ops })) as { results: OpResult[] }
    this.stats.ops += ops.length
    for (const [i, op] of ops.entries()) {
      try {
        await this.settle(op, results[i])
      } catch (e) {
        if (e instanceof NetError) throw e
        this.fail(op.path, e)
      }
    }
    this.stats.lastSync = Date.now()
  }

  private async settle(op: Op, r: OpResult) {
    const { path } = op
    if (r.status === 'ok' || r.status === 'merged') {
      this.stale.delete(path)
      if (r.hash !== op.hash && !(await this.place(path, r.hash, op.hash))) {
        // edited again while we were uploading: keep that edit, it merges on the next round
        this.state.setFile(this.p.id, path, r.version, op.hash)
        return this.touch(path)
      }
      this.state.setFile(this.p.id, path, r.version, r.hash)
      this.errors.delete(path)
      if (op.hash !== op.baseHash) this.log(`${r.status === 'merged' ? 'merged' : '↑'} ${path} (v${r.version})`)
    } else if (r.status === 'conflict') {
      // The server keeps our content as candidate B; this file keeps it locally too.
      this.state.setFile(this.p.id, path, r.version, op.hash)
      this.blocked.add(path)
    } else if (r.status === 'blocked') {
      this.blocked.add(path)
    } else if (r.status === 'busy') {
      setTimeout(() => {
        this.ready.add(path)
        this.kick()
      }, 2000).unref()
    } else this.fail(path, r.error ?? 'rejected by server')
  }

  // ── download ────────────────────────────────────────────────────────────

  private async pull(heads: Head[]) {
    for (let i = 0; i < heads.length; i += 32) {
      const chunk = heads.slice(i, i + 32)
      if (heads.length > 1) await this.prefetch(chunk)
      for (const h of chunk) await this.apply(h)
      this.prefetched.clear()
    }
  }

  private async prefetch(heads: Head[]) {
    const want = new Set<Hash>()
    for (const h of heads) if (h.hash && !this.ignored(h.path) && h.version > this.state.file(this.p.id, h.path).version) want.add(h.hash)
    await pool([...want], 8, async hash => {
      this.prefetched.set(hash, await this.api('GET', `/blobs/${hash}`))
    })
  }

  private async apply(h: Head) {
    let path: string
    try {
      path = cleanPath(h.path)
    } catch {
      return this.log(`refused remote path ${JSON.stringify(h.path)}`)
    }
    if (this.ignored(path)) return // ignored here means invisible both ways (e.g. our own .env)
    const st = this.state.file(this.p.id, path)
    if (h.version <= st.version) return // duplicate, echo of our own upload, or outdated
    try {
      const disk = (await this.read(path))?.hash ?? null
      if (disk === h.hash || (disk === st.hash && (await this.place(path, h.hash, disk)))) {
        this.state.setFile(this.p.id, path, h.version, h.hash)
        this.stale.delete(path)
        this.errors.delete(path)
        if (disk !== h.hash) this.log(`↓ ${path}${h.author ? ` from ${h.author.replace(/ \(.*\)$/, '')}` : ''}`)
        return
      }
      // Unsynced local edits: never overwrite them. Upload instead; the server merges.
      this.stale.add(path)
      this.touch(path)
    } catch (e) {
      if (e instanceof NetError) throw e
      this.fail(path, e)
    }
  }

  /** Writes server content (null = delete) only if the local file still holds `expect`. */
  private async place(path: string, hash: Hash | null, expect: Hash | null) {
    const bytes = hash === null ? null : await this.download(hash) // network first: NetError propagates
    await this.inside(path)
    const abs = join(this.root, path)
    const now = async () => (await this.read(path))?.hash ?? null
    if (bytes === null) {
      if ((await now()) !== expect) return false
      await rm(abs, { force: true })
      await this.prune(path)
      return true
    }
    await mkdir(dirname(abs), { recursive: true })
    const tmp = join(this.root, '.synchack', 'tmp', randomBytes(8).toString('hex'))
    await mkdir(dirname(tmp), { recursive: true })
    await writeFile(tmp, bytes)
    try {
      // ponytail: a write landing between this check and the rename is lost locally (microseconds)
      if ((await now()) !== expect) return false
      if (expect === null) await link(tmp, abs) // atomic create; fails if a file appeared meanwhile
      else await rename(tmp, abs) // atomic replace: readers see old or new, never half a file
      return true
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw e
    } finally {
      await rm(tmp, { force: true })
    }
  }

  /** Refuses writes that would leave the project through a symlinked folder. */
  private async inside(path: string) {
    let dir = dirname(join(this.root, path))
    while (!existsSync(dir)) dir = dirname(dir)
    const real = await realpath(dir)
    if (real !== this.root && !real.startsWith(this.root + sep)) throw new Error('resolves outside the project folder; not written')
  }

  private async prune(path: string) {
    for (let d = dirname(path); d !== '.'; d = dirname(d)) {
      try {
        await rmdir(join(this.root, d))
      } catch {
        return
      }
    }
  }

  private async download(hash: Hash): Promise<Buffer> {
    const bytes = this.prefetched.get(hash) ?? ((await this.api('GET', `/blobs/${hash}`)) as Buffer)
    if (sha256(bytes) !== hash) throw new NetError(`download of ${hash.slice(0, 12)} was corrupted`)
    this.stats.downloads++
    return bytes
  }

  // ── connection ──────────────────────────────────────────────────────────

  private api(method: string, path: string, body?: unknown) {
    return call(this.p, method, path, body)
  }

  private connect() {
    if (this.stopped || this.ws || this.mode === 'paused') return
    const url = `${this.p.server.replace(/^http/, 'ws')}/api/p/${this.p.id}/ws?token=${encodeURIComponent(this.p.token)}&since=${this.p.seq}`
    const ws = new WebSocket(url)
    this.ws = ws
    this.lastMsg = Date.now()
    ws.onmessage = e => {
      this.lastMsg = Date.now()
      let msg: ServerMsg
      try {
        msg = JSON.parse(String(e.data))
      } catch {
        return this.log('ignored a malformed server message')
      }
      this.enqueue(() => this.receive(ws, msg))
    }
    ws.onclose = e => this.drop(ws, e.code)
    ws.onerror = () => {} // onclose follows
  }

  private drop(ws: WebSocket, code?: number) {
    if (this.ws !== ws) return
    this.ws = undefined
    ws.close()
    if (code === REMOVED) {
      this.online = false
      this.errors.set('', 'no longer a member of this project; not syncing')
      this.log('no longer a member of this project; stopped syncing')
      return void this.emit('status')
    }
    if (this.online && !this.stopped && this.mode !== 'paused') this.log('offline; changes stay local until the server is back')
    this.online = false
    this.emit('status')
    if (this.stopped || this.mode === 'paused') return
    const delay = Math.min(this.opts.reconnectMaxMs, 250 * 2 ** this.backoff++) * (0.5 + Math.random() / 2)
    this.reconnect = setTimeout(() => this.connect(), delay)
  }

  private async receive(ws: WebSocket, msg: ServerMsg) {
    if (ws !== this.ws) return // from a socket we already dropped
    try {
      if (msg.type === 'hello') {
        this.members = msg.members
        this.conflicts = new Map(msg.conflicts.map(c => [c.id, c]))
        this.blocked = new Set(msg.conflicts.map(c => c.path))
        this.log(msg.heads.length ? `connected; catching up on ${msg.heads.length} remote change(s)` : 'connected')
        await this.pull(msg.heads)
        this.setSeq(msg.seq)
        this.backoff = 0
        this.online = true
        for (const h of (await this.api('GET', '/heads')).heads as Head[]) this.note(h)
        await this.fullScan() // edits made while offline or before start
      } else if (msg.type === 'change') {
        this.note(msg.head)
        await this.pull([msg.head])
        if (msg.head.seq > this.p.seq) this.setSeq(msg.head.seq)
      } else if (msg.type === 'conflict') this.onConflict(msg.conflict)
      else if (msg.type === 'members') this.members = msg.members
      this.emit('status')
    } catch (e) {
      // Unapplied events must not be skipped: reconnect and catch up from the last good seq.
      this.log(`sync interrupted (${(e as Error).message}); reconnecting`)
      this.drop(ws)
    }
  }

  private onConflict(c: Conflict) {
    const known = this.conflicts.has(c.id)
    if (c.status === 'open') {
      this.conflicts.set(c.id, c)
      this.blocked.add(c.path)
      const who = (a: string | null) => (a ?? '?').replace(/ \(.*\)$/, '')
      if (!known) this.log(`conflict on ${c.path}: ${who(c.a.author)} vs ${who(c.b.author)}, both versions kept`)
    } else {
      this.conflicts.delete(c.id)
      this.blocked.delete(c.path)
      this.touch(c.path) // upload anything edited while it was held
      this.log(`conflict on ${c.path} resolved by ${c.resolvedBy}`)
    }
    this.emit('conflict', c)
  }

  /** Files changed here and not uploaded yet: what this Mac is editing right now. */
  editing() {
    return [...new Set([...this.timers.keys(), ...this.ready])]
  }

  private note(h: Head) {
    if (!h.device) return
    this.activity.set(h.path, { device: h.device, author: h.author, at: h.at, deleted: h.hash === null })
    this.emit('activity')
  }

  private setSeq(seq: number) {
    this.p.seq = seq
    this.state.setSeq(this.p.id, seq)
  }

  private fail(path: string, e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    this.errors.set(path, msg)
    this.log(`${path || 'sync'}: ${msg}`)
  }

  private log(line: string) {
    this.emit('log', line)
  }
}

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>) {
  const it = items.values() // shared iterator: each worker pulls the next item
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (const x of it) await fn(x)
  }))
}
