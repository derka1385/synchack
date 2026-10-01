// Authoritative project state: SQLite for metadata, content-addressed files for blobs.
// Every method is synchronous, so each check-and-commit is atomic on Node's single thread.
// ponytail: one SQLite file per server; move to Postgres once more than one instance must share it.

import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { randomBytes, randomInt } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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
`

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // no 0/O or 1/I/L
export const randomId = (bytes = 16) => randomBytes(bytes).toString('base64url')
const label = (m: Device) => `${m.name} (${m.deviceName})`

export class Store {
  readonly dir: string
  readonly db: DatabaseSync

  constructor(dir: string) {
    this.dir = dir
    mkdirSync(join(dir, 'blobs'), { recursive: true })
    this.db = new DatabaseSync(join(dir, 'server.db'))
    this.db.exec(SCHEMA)
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
    let code: string
    do code = Array.from({ length: 6 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('').replace(/^(...)/, '$1-')
    while (this.one('select 1 from projects where code = ?', code))
    this.run('insert into projects (id, code, name, created) values (?, ?, ?, ?)', id, code, name, Date.now())
    return { projectId: id, name, code, token: this.addMember({ ...who, project: id }) }
  }

  // ponytail: no rate limit on guesses; 31^6 codes are plenty for a hackathon, add one before going public
  join(code: string, who: Omit<Device, 'project'>) {
    const clean = code.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(...)/, '$1-')
    const p = this.one<{ id: string; name: string; code: string }>('select id, name, code from projects where code = ?', clean)
    return p && { projectId: p.id, name: p.name, code: p.code, token: this.addMember({ ...who, project: p.id }) }
  }

  private addMember(m: Device) {
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
    return this.all<{ device: string; name: string; deviceName: string }>(
      'select device, name, device_name as deviceName from members where project = ? order by joined', project,
    )
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

  history(project: string, path: string) {
    return this.all<{ version: number; hash: Hash | null; author: string | null; at: number }>(
      'select version, hash, author, at from versions where project = ? and path = ? order by version', project, path,
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

  /** Content-addressed and write-once. Never deleted: old versions stay recoverable. */
  putBlob(project: string, bytes: Uint8Array): Hash {
    const hash = sha256(bytes)
    const file = this.blobPath(project, hash)
    if (!existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.${randomId(6)}`
      writeFileSync(tmp, bytes)
      renameSync(tmp, file)
    }
    return hash
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
        results.push({ status: 'error', version: 0, hash: null, error: (e as Error).message })
      }
    }
    return { results, events }
  }

  private applyOp(m: Device, op: Op): { result: OpResult; head?: Head; conflict?: Conflict } {
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
    try {
      const [o, a, b] = [base, ours, theirs].map(h => (h === null ? new Uint8Array() : this.readBlob(project, h)))
      if (![o, a, b].every(isText)) return undefined
      const r = merge3(decode(o), decode(a), decode(b))
      return r.conflicts ? undefined : this.putBlob(project, Buffer.from(r.text))
    } catch {
      return undefined // unknown base or a diff too big to trust: keep both
    }
  }

  private commit(m: Device, path: string, hash: Hash | null, op: string | null): Head {
    const { seq } = this.one<{ seq: number }>('update projects set seq = seq + 1 where id = ? returning seq', m.project)!
    const h: Head = { path, version: this.head(m.project, path).version + 1, hash, seq, device: m.device, author: label(m), at: Date.now() }
    this.run(
      `insert into heads (project, path, version, hash, seq, device, author, at) values (?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (project, path) do update set version = excluded.version, hash = excluded.hash, seq = excluded.seq,
       device = excluded.device, author = excluded.author, at = excluded.at`,
      m.project, path, h.version, hash, seq, m.device, h.author, h.at,
    )
    this.run('insert into versions (project, path, version, hash, device, author, op, at) values (?, ?, ?, ?, ?, ?, ?, ?)', m.project, path, h.version, hash, m.device, h.author, op, h.at)
    return h
  }

  // ── conflicts ───────────────────────────────────────────────────────────

  conflicts(project: string, all = false): Conflict[] {
    return this.all<{ data: string }>(`select data from conflicts where project = ? ${all ? '' : "and status = 'open'"} order by rowid`, project).map(r => JSON.parse(r.data))
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
    if (hash === undefined) throw new Error('choose A, B or provide merged content')
    if (hash !== null && !this.hasBlob(m.project, hash)) throw new Error('merged content was not uploaded')
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

function checkOp(o: unknown): Op {
  const x = o as Op
  const hashOk = (h: unknown) => h === null || (typeof h === 'string' && HASH_RE.test(h))
  if (!x || typeof x.opId !== 'string' || x.opId.length > 128 || !Number.isInteger(x.baseVersion) || x.baseVersion < 0 || !hashOk(x.baseHash) || !hashOk(x.hash))
    throw new Error('malformed op')
  return x
}
