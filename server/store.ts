// Authoritative project state: SQLite for metadata, content-addressed files for blobs.
// Every method is synchronous, so each check-and-commit is atomic on Node's single thread.
// ponytail: one SQLite file per server; move to Postgres once more than one instance must share it.

import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { randomBytes, randomInt } from 'node:crypto'
import { closeSync, cpSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { HASH_RE, sha256, type Conflict, type Hash, type Head, type Op, type OpResult, type ServerMsg } from '../shared/protocol.ts'
import { cleanPath } from '../shared/paths.ts'
import { decode, isText, merge3 } from '../shared/merge.ts'

export interface Device {
  project: string
  device: string
  name: string
  deviceName: string
}

const SCHEMA = `
  pragma journal_mode = wal;
  create table if not exists projects (id text primary key, code text not null unique, name text not null, seq integer not null default 0, created integer not null);
  create table if not exists members (project text not null, device text not null, name text not null, device_name text not null, token text not null unique, joined integer not null, primary key (project, device));
  create table if not exists heads (project text not null, path text not null, version integer not null, hash text, seq integer not null, device text, author text, at integer not null, primary key (project, path));
  create index if not exists heads_by_seq on heads (project, seq);
  create table if not exists versions (project text not null, path text not null, version integer not null, hash text, device text, author text, op text, at integer not null, primary key (project, path, version));
  create index if not exists versions_by_op on versions (project, op);
  create table if not exists conflicts (id text primary key, project text not null, path text not null, op text, status text not null, data text not null);
  create index if not exists conflicts_by_path on conflicts (project, path, status);
  create table if not exists blobs (project text not null, hash text not null, size integer not null, primary key (project, hash));
`

/** Larger texts are not merged on the server (a merge of 200k lines costs ~0.4 s of CPU). */
export const MAX_MERGE_LINES = 200_000
/** Merges may use about half the server's time, in bursts of up to this many ms. */
const MERGE_BURST_MS = 2000

/** An op the server has no time for right now: the client retries it shortly. */
export class Busy extends Error {}

/** Invites stop working this long after they were made; members are unaffected. */
export const INVITE_TTL = 48 * 60 * 60 * 1000

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // no 0/O or 1/I/L
export const randomId = (bytes = 16) => randomBytes(bytes).toString('base64url')
const label = (m: Device) => `${m.name} (${m.deviceName})`

export class Store {
  readonly dir: string
  readonly db: DatabaseSync
  readonly quota: number // bytes of blobs per project
  private mergeDebt = 0 // ms of merge work not yet paid back
  private debtAt = Date.now()

  constructor(dir: string, { quota = 5 * 1024 ** 3 } = {}) {
    this.dir = dir
    this.quota = quota
    mkdirSync(join(dir, 'blobs'), { recursive: true })
    this.db = new DatabaseSync(join(dir, 'server.db'))
    this.db.exec(SCHEMA)
    // Columns added after the first release: older server.db files get them here.
    const cols = new Set(this.all<{ name: string }>('pragma table_info(projects)').map(c => c.name))
    if (!cols.has('owner')) this.db.exec('alter table projects add column owner text')
    if (!cols.has('code_expires')) this.db.exec(`alter table projects add column code_expires integer not null default ${Date.now() + INVITE_TTL}`)
    // paths folded to lower case: on a Mac, A.txt and a.txt are the same file (see applyOp)
    if (!this.all<{ name: string }>('pragma table_info(heads)').some(c => c.name === 'fold')) {
      this.db.exec('alter table heads add column fold text')
      this.tx(() => {
        for (const h of this.all<{ project: string; path: string }>('select project, path from heads'))
          this.run('update heads set fold = ? where project = ? and path = ?', fold(h.path), h.project, h.path)
      })
    }
    this.db.exec('create index if not exists heads_by_fold on heads (project, fold)')
  }

  private one<T>(sql: string, ...args: SQLInputValue[]) {
    return this.db.prepare(sql).get(...args) as T | undefined
  }

  private all<T>(sql: string, ...args: SQLInputValue[]) {
    return this.db.prepare(sql).all(...args) as T[]
  }

  private run(sql: string, ...args: SQLInputValue[]) {
    this.db.prepare(sql).run(...args)
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('begin immediate')
    try {
      const r = fn()
      this.db.exec('commit')
      return r
    } catch (e) {
      this.db.exec('rollback')
      throw e
    }
  }

  // ── projects and members ────────────────────────────────────────────────

  createProject(name: string, who: Omit<Device, 'project'>) {
    const id = randomId() // never shown to users; the join code is a separate secret
    const code = this.newCode()
    this.run('insert into projects (id, code, name, created, owner, code_expires) values (?, ?, ?, ?, ?, ?)', id, code, name, Date.now(), who.device, Date.now() + INVITE_TTL)
    return { projectId: id, name, code, token: this.addMember({ ...who, project: id }) }
  }

  private newCode() {
    let code: string
    do code = Array.from({ length: 8 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('').replace(/^(....)/, '$1-')
    while (this.one('select 1 from projects where code = ?', code))
    return code
  }

  /**
   * Guessing is slowed by the server's per-address rate limit; codes also expire. A device that
   * is already a member must prove it with its current token, so nobody can take over a
   * teammate's identity by joining with their (visible) device id.
   */
  join(code: string, who: Omit<Device, 'project'>, token: string | null = null) {
    const raw = code.toUpperCase().replace(/[^A-Z0-9]/g, '')
    const clean = raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw.replace(/^(...)/, '$1-')
    const p = this.one<{ id: string; name: string; code: string }>('select id, name, code from projects where code = ? and code_expires > ?', clean, Date.now())
    if (!p) return undefined
    const known = this.one<{ token: string }>('select token from members where project = ? and device = ?', p.id, who.device)
    if (known && (!token || sha256(token) !== known.token))
      throw Object.assign(new Error('this device has already joined this project'), { status: 409 })
    return { projectId: p.id, name: p.name, code: p.code, token: this.addMember({ ...who, project: p.id }) }
  }

  /** The current invite code, replaced by a new one when asked or when it has expired. */
  invite(project: string, rotate = false) {
    const p = this.one<{ code: string; expires: number }>('select code, code_expires as expires from projects where id = ?', project)!
    if (!rotate && p.expires > Date.now()) return p
    const fresh = { code: this.newCode(), expires: Date.now() + INVITE_TTL }
    this.run('update projects set code = ?, code_expires = ? where id = ?', fresh.code, fresh.expires, project)
    return fresh
  }

  owner(project: string) {
    return this.one<{ owner: string | null }>('select owner from projects where id = ?', project)?.owner ?? null
  }

  /**
   * The project's creator can remove anyone; everyone can remove themselves. Removing someone
   * else also replaces the invite code, so the old invite can't bring them back.
   */
  removeMember(m: Device, device: string) {
    if (device !== m.device && this.owner(m.project) !== m.device)
      throw Object.assign(new Error('only the project creator can remove teammates'), { status: 403 })
    if (!this.one('select 1 from members where project = ? and device = ?', m.project, device))
      throw Object.assign(new Error('no such member'), { status: 404 })
    this.run('delete from members where project = ? and device = ?', m.project, device)
    return device === m.device ? undefined : this.invite(m.project, true)
  }

  /**
   * Display names are unique within a project (case and width folded): a teammate can't appear
   * as "Nolann" next to Nolann. The second one becomes "Nolann 2".
   */
  private uniqueName(project: string, device: string, name: string) {
    const key = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
    const taken = new Set(this.all<{ name: string }>('select name from members where project = ? and device <> ?', project, device).map(r => key(r.name)))
    let out = name
    for (let i = 2; taken.has(key(out)); i++) out = `${name.slice(0, 190)} ${i}`
    return out
  }

  private addMember(m: Device) {
    m = { ...m, name: this.uniqueName(m.project, m.device, m.name) }
    const token = randomId(32) // stored hashed; joining again from the same device rotates it
    this.run(
      `insert into members (project, device, name, device_name, token, joined) values (?, ?, ?, ?, ?, ?)
       on conflict (project, device) do update set name = excluded.name, device_name = excluded.device_name, token = excluded.token`,
      m.project, m.device, m.name, m.deviceName, sha256(token), Date.now(),
    )
    return token
  }

  auth(project: string, token: string | null): Device | undefined {
    if (!token) return undefined
    return this.one<Device>(
      'select project, device, name, device_name as deviceName from members where project = ? and token = ?',
      project, sha256(token),
    )
  }

  members(project: string) {
    const owner = this.owner(project)
    return this.all<{ device: string; name: string; deviceName: string }>(
      'select device, name, device_name as deviceName from members where project = ? order by joined', project,
    ).map(m => ({ ...m, owner: m.device === owner }))
  }

  // ── files ───────────────────────────────────────────────────────────────

  seq(project: string) {
    return this.one<{ seq: number }>('select seq from projects where id = ?', project)?.seq ?? 0
  }

  /** Current heads changed after `since`, in commit order: the catch-up after a reconnect. */
  heads(project: string, since = 0) {
    return this.all<Head>('select path, version, hash, seq, device, author, at from heads where project = ? and seq > ? order by seq', project, since)
  }

  head(project: string, path: string): Head {
    return (
      this.one<Head>('select path, version, hash, seq, device, author, at from heads where project = ? and path = ?', project, path) ??
      { path, version: 0, hash: null, seq: 0, device: null, author: null, at: 0 }
    )
  }

  /** The newest `limit` versions of a path, oldest first. */
  history(project: string, path: string, limit = 1000) {
    return this.all<{ version: number; hash: Hash | null; author: string | null; at: number }>(
      'select * from (select version, hash, author, at from versions where project = ? and path = ? order by version desc limit ?) order by version', project, path, limit,
    )
  }

  blobPath(project: string, hash: Hash) {
    return join(this.dir, 'blobs', project, hash.slice(0, 2), hash)
  }

  hasBlob(project: string, hash: Hash) {
    return existsSync(this.blobPath(project, hash))
  }

  readBlob(project: string, hash: Hash) {
    return readFileSync(this.blobPath(project, hash))
  }

  /** Bytes stored for a project (blobs written before sizes were tracked are not counted). */
  used(project: string) {
    return this.one<{ n: number }>('select coalesce(sum(size), 0) as n from blobs where project = ?', project)!.n
  }

  /** Throws unless `bytes` more fit in the project's quota. */
  reserve(project: string, bytes: number) {
    if (this.used(project) + bytes > this.quota)
      throw Object.assign(new Error(`project storage is full (${Math.round(this.quota / 1024 ** 3)} GB)`), { status: 507 })
  }

  /** A temp file for an upload, inside the blob dir so the final rename stays on one disk. */
  tempPath() {
    mkdirSync(join(this.dir, 'blobs', 'tmp'), { recursive: true })
    return join(this.dir, 'blobs', 'tmp', randomId(12))
  }

  /** Content-addressed and write-once. Never deleted: old versions stay recoverable. */
  putBlob(project: string, bytes: Uint8Array): Hash {
    const hash = sha256(bytes)
    if (!this.hasBlob(project, hash)) {
      const tmp = this.tempPath()
      writeFileSync(tmp, bytes)
      this.adoptBlob(project, tmp, hash, bytes.length)
    }
    return hash
  }

  /**
   * Moves a fully written temp file into place as blob `hash`. The file is flushed to disk
   * before the rename, so a commit can never point at a blob a power cut left empty.
   */
  adoptBlob(project: string, tmp: string, hash: Hash, size: number, synced = false) {
    const file = this.blobPath(project, hash)
    if (existsSync(file)) return void rmSync(tmp, { force: true })
    if (!synced) {
      const fd = openSync(tmp, 'r+')
      try {
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    }
    mkdirSync(dirname(file), { recursive: true })
    renameSync(tmp, file)
    syncDir(dirname(file))
    this.run('insert or ignore into blobs (project, hash, size) values (?, ?, ?)', project, hash, size)
  }

  /** Applies a batch in order. Returns per-op results and the events to broadcast. */
  applyOps(m: Device, ops: unknown[]) {
    const results: OpResult[] = []
    const events: ServerMsg[] = []
    for (const raw of ops) {
      try {
        const r = this.tx(() => this.applyOp(m, checkOp(raw)))
        results.push(r.result)
        if (r.head) events.push({ type: 'change', head: r.head })
        if (r.conflict) events.push({ type: 'conflict', conflict: r.conflict })
      } catch (e) {
        if (e instanceof Busy) results.push({ status: 'busy', version: 0, hash: null, error: e.message })
        else results.push({ status: 'error', version: 0, hash: null, error: (e as Error).message })
      }
    }
    return { results, events }
  }

  private applyOp(m: Device, raw: Op): { result: OpResult; head?: Head; conflict?: Conflict } {
    const op = { ...raw, opId: `${m.device}\n${raw.opId}` }
    const path = cleanPath(op.path)
    const head = this.head(m.project, path)
    const now = { version: head.version, hash: head.hash }
    // a retry of an op we already handled gets the same answer, not a spurious conflict
    const done = this.one<{ version: number; hash: Hash | null }>('select version, hash from versions where project = ? and op = ?', m.project, op.opId)
    if (done) return { result: { status: done.hash === op.hash ? 'ok' : 'merged', ...done } }
    const held = this.one<{ id: string }>('select id from conflicts where project = ? and op = ?', m.project, op.opId)
    if (held) return { result: { status: 'conflict', conflictId: held.id, ...now } }

    if (op.hash === op.baseHash || op.hash === head.hash) return { result: { status: 'ok', ...now } } // nothing to change
    const open = this.one<{ id: string }>("select id from conflicts where project = ? and path = ? and status = 'open'", m.project, path)
    if (open) return { result: { status: 'blocked', conflictId: open.id, ...now } }
    if (op.hash && !this.hasBlob(m.project, op.hash)) throw new Error(`content ${op.hash} was not uploaded`)

    if (head.hash === null && op.hash !== null) {
      const twin = this.one<{ path: string }>('select path from heads where project = ? and fold = ? and path <> ? and hash is not null limit 1', m.project, fold(path), path)
      if (twin) throw new Error(`"${path}" differs from "${twin.path}" only in letter case: on a Mac they are the same file. Rename one of them.`)
    }
    if (op.baseHash === head.hash) {
      const h = this.commit(m, path, op.hash, op.opId) // fast-forward
      return { result: { status: 'ok', version: h.version, hash: h.hash }, head: h }
    }
    // The server moved on since this client's base: merge, never last-write-wins.
    const merged = this.merge(m.project, op.baseHash, op.hash, head.hash)
    if (merged === head.hash) return { result: { status: 'ok', ...now } } // already contained
    if (merged !== undefined) {
      const h = this.commit(m, path, merged, op.opId)
      return { result: { status: 'merged', version: h.version, hash: h.hash }, head: h }
    }
    const conflict: Conflict = {
      id: randomId(6),
      path,
      base: op.baseHash,
      a: { hash: head.hash, device: head.device, author: head.author, at: head.at },
      b: { hash: op.hash, device: m.device, author: label(m), at: Date.now() },
      votes: {},
      status: 'open',
      resolvedBy: null,
      at: Date.now(),
    }
    this.run('insert into conflicts (id, project, path, op, status, data) values (?, ?, ?, ?, ?, ?)', conflict.id, m.project, path, op.opId, 'open', JSON.stringify(conflict))
    return { result: { status: 'conflict', conflictId: conflict.id, ...now }, conflict }
  }

  /** Three-way text merge. undefined = must become a conflict (binary, delete vs edit, overlap). */
  private merge(project: string, base: Hash | null, ours: Hash | null, theirs: Hash | null): Hash | undefined {
    if (ours === null || theirs === null) return undefined
    // Merges run on the one thread every client shares, so their CPU time is rationed.
    const now = Date.now()
    this.mergeDebt = Math.max(0, this.mergeDebt - (now - this.debtAt) / 2)
    this.debtAt = now
    if (this.mergeDebt > MERGE_BURST_MS) throw new Busy('server is busy merging; retry shortly')
    try {
      const [o, a, b] = [base, ours, theirs].map(h => (h === null ? new Uint8Array() : this.readBlob(project, h)))
      if (![o, a, b].every(isText)) return undefined
      const texts = [o, a, b].map(decode)
      if (texts.reduce((n, t) => n + lineCount(t), 0) > MAX_MERGE_LINES) return undefined
      const r = merge3(texts[0], texts[1], texts[2])
      return r.conflicts ? undefined : this.putBlob(project, Buffer.from(r.text))
    } catch {
      return undefined // unknown base or a diff too big to trust: keep both
    } finally {
      this.mergeDebt += Date.now() - now
    }
  }

  private commit(m: Device, path: string, hash: Hash | null, op: string | null): Head {
    const { seq } = this.one<{ seq: number }>('update projects set seq = seq + 1 where id = ? returning seq', m.project)!
    const h: Head = { path, version: this.head(m.project, path).version + 1, hash, seq, device: m.device, author: label(m), at: Date.now() }
    this.run(
      `insert into heads (project, path, version, hash, seq, device, author, at, fold) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (project, path) do update set version = excluded.version, hash = excluded.hash, seq = excluded.seq,
       device = excluded.device, author = excluded.author, at = excluded.at`,
      m.project, path, h.version, hash, seq, m.device, h.author, h.at, fold(path),
    )
    this.run('insert into versions (project, path, version, hash, device, author, op, at) values (?, ?, ?, ?, ?, ?, ?, ?)', m.project, path, h.version, hash, m.device, h.author, op, h.at)
    return h
  }

  /**
   * A consistent copy of everything in `dest` (which must not exist): a snapshot of the
   * database, then the blobs. Blobs are written before the commits that use them and never
   * deleted, so every blob the snapshot refers to is already there when they are copied.
   */
  backup(dest: string) {
    if (existsSync(dest)) throw new Error(`${dest} already exists`)
    mkdirSync(dest, { recursive: true })
    this.db.prepare('vacuum into ?').run(join(dest, 'server.db'))
    cpSync(join(this.dir, 'blobs'), join(dest, 'blobs'), { recursive: true, filter: src => !src.startsWith(join(this.dir, 'blobs', 'tmp')) })
  }

  // ── conflicts ───────────────────────────────────────────────────────────

  /** Open conflicts, or with `all` also the newest resolved ones (up to 1000 in total). */
  conflicts(project: string, all = false): Conflict[] {
    const rows = this.all<{ data: string }>(`select data from conflicts where project = ? ${all ? '' : "and status = 'open'"} order by rowid desc limit 1000`, project)
    return rows.reverse().map(r => JSON.parse(r.data))
  }

  conflict(project: string, id: string): Conflict | undefined {
    const r = this.one<{ data: string }>('select data from conflicts where project = ? and id = ?', project, id)
    return r && JSON.parse(r.data)
  }

  private save(project: string, c: Conflict) {
    this.run('update conflicts set status = ?, data = ? where project = ? and id = ?', c.status, JSON.stringify(c), project, c.id)
  }

  vote(m: Device, id: string, choice: 'A' | 'B') {
    const c = this.openConflict(m.project, id)
    c.votes[m.device] = choice
    this.save(m.project, c)
    return c
  }

  /**
   * Commits the chosen candidate (or a hand-merged blob) as a new version, even when it equals
   * the current head: the side holding the other candidate needs a newer version to move to.
   * Both candidates remain in the conflict record and blob store.
   */
  resolve(m: Device, id: string, pick: { choice?: 'A' | 'B'; hash?: Hash | null }) {
    const c = this.openConflict(m.project, id)
    const hash = pick.choice === 'A' ? c.a.hash : pick.choice === 'B' ? c.b.hash : pick.hash
    if (hash === undefined) throw Object.assign(new Error('choose A, B or provide merged content'), { status: 400 })
    if (hash !== null && !this.hasBlob(m.project, hash)) throw Object.assign(new Error('merged content was not uploaded'), { status: 400 })
    return this.tx(() => {
      c.status = 'resolved'
      c.resolvedBy = label(m)
      this.save(m.project, c)
      return { head: this.commit(m, c.path, hash, null), conflict: c }
    })
  }

  private openConflict(project: string, id: string) {
    const c = this.conflict(project, id)
    if (!c) throw Object.assign(new Error('no such conflict'), { status: 404 })
    if (c.status !== 'open') throw Object.assign(new Error('conflict already resolved'), { status: 409 })
    return c
  }
}

/** How APFS compares names: NFC and case-insensitive. */
const fold = (path: string) => path.normalize('NFC').toLowerCase()

function lineCount(s: string) {
  let n = 0
  for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) n++
  return n
}

/** Makes a rename durable: the directory entry itself is flushed. */
function syncDir(dir: string) {
  try {
    const fd = openSync(dir, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {} // not supported on every platform; the file itself is already flushed
}

function checkOp(o: unknown): Op {
  const x = o as Op
  const hashOk = (h: unknown) => h === null || (typeof h === 'string' && HASH_RE.test(h))
  if (!x || typeof x.opId !== 'string' || x.opId.length > 128 || !Number.isInteger(x.baseVersion) || x.baseVersion < 0 || !hashOk(x.baseHash) || !hashOk(x.hash))
    throw new Error('malformed op')
  return x
}
