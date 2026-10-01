// Local persistent state (one SQLite file per device, shared by all its projects).
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { hostname, userInfo } from 'node:os'
import { join, sep } from 'node:path'
import type { Hash, Mode } from '../shared/protocol.ts'

export interface Project {
  id: string
  name: string
  root: string
  server: string
  token: string
  code: string
  mode: Mode
  seq: number // last server commit applied here
  cert: string | null // the host's self-signed certificate (PEM), pinned; null for plain HTTP or a CA-signed server
}

/** The server content a local file was last in sync with. */
export interface FileState {
  version: number
  hash: Hash | null
}

export class LocalState {
  readonly home: string
  readonly db: DatabaseSync

  constructor(home: string) {
    this.home = home
    mkdirSync(home, { recursive: true })
    this.db = new DatabaseSync(join(home, 'state.db'))
    this.db.exec(`
      pragma journal_mode = wal;
      pragma busy_timeout = 5000;
      create table if not exists meta (key text primary key, value text not null);
      create table if not exists projects (id text primary key, name text not null, root text not null unique, server text not null,
        token text not null, code text not null, mode text not null default 'live', seq integer not null default 0, status text);
      create table if not exists files (project text not null, path text not null, version integer not null, hash text, primary key (project, path));
    `)
    const cols = this.db.prepare('pragma table_info(projects)').all().map(c => c.name)
    if (!cols.includes('cert')) this.db.exec('alter table projects add column cert text')
  }

  private one<T>(sql: string, ...args: SQLInputValue[]) {
    return this.db.prepare(sql).get(...args) as T | undefined
  }

  private run(sql: string, ...args: SQLInputValue[]) {
    this.db.prepare(sql).run(...args)
  }

  meta(key: string) {
    return this.one<{ value: string }>('select value from meta where key = ?', key)?.value
  }

  setMeta(key: string, value: string) {
    this.run('insert into meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value', key, value)
  }

  get device() {
    let id = this.meta('device')
    if (!id) this.setMeta('device', (id = randomUUID()))
    return id
  }

  identity() {
    return { device: this.device, user: this.meta('user') ?? userInfo().username, deviceName: hostname().replace(/\.local$/, '') }
  }

  projects() {
    return this.db.prepare('select id, name, root, server, token, code, mode, seq, cert from projects order by name').all() as unknown as Project[]
  }

  project(id: string) {
    return this.one<Project>('select id, name, root, server, token, code, mode, seq, cert from projects where id = ?', id)
  }

  /** The project whose folder contains `dir`. */
  projectAt(dir: string) {
    return this.projects().find(p => dir === p.root || dir.startsWith(p.root + sep))
  }

  addProject(p: Project) {
    this.run('insert into projects (id, name, root, server, token, code, mode, seq, cert) values (?, ?, ?, ?, ?, ?, ?, ?, ?)', p.id, p.name, p.root, p.server, p.token, p.code, p.mode, p.seq, p.cert)
  }

  setMode(id: string, mode: Mode) {
    this.run('update projects set mode = ? where id = ?', mode, id)
  }

  removeProject(id: string) {
    this.run('delete from files where project = ?', id)
    this.run('delete from projects where id = ?', id)
  }

  setCode(id: string, code: string) {
    this.run('update projects set code = ? where id = ?', code, id)
  }

  setSeq(id: string, seq: number) {
    this.run('update projects set seq = ? where id = ?', seq, id)
  }

  setStatus(id: string, status: object) {
    this.run('update projects set status = ? where id = ?', JSON.stringify(status), id)
  }

  status(id: string) {
    const s = this.one<{ status: string | null }>('select status from projects where id = ?', id)?.status
    return s ? JSON.parse(s) : undefined
  }

  file(project: string, path: string): FileState {
    return this.one<FileState>('select version, hash from files where project = ? and path = ?', project, path) ?? { version: 0, hash: null }
  }

  setFile(project: string, path: string, version: number, hash: Hash | null) {
    this.run(
      'insert into files (project, path, version, hash) values (?, ?, ?, ?) on conflict (project, path) do update set version = excluded.version, hash = excluded.hash',
      project, path, version, hash,
    )
  }

  /** Paths we last saw as existing, optionally only those under `prefix` (e.g. "src/"). */
  tracked(project: string, prefix = '') {
    const rows = this.db.prepare('select path from files where project = ? and hash is not null and path >= ? and path < ?').all(project, prefix, prefix + '\u{10FFFF}')
    return rows.map(r => r.path as string)
  }
}
