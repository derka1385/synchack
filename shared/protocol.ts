// Wire types shared by server and clients. JSON everywhere except blob bodies (raw bytes).
import { createHash } from 'node:crypto'
import { networkInterfaces } from 'node:os'

export type Hash = string // sha256 hex of a file's bytes
export type Mode = 'live' | 'calm' | 'paused'

/** The server's current state of one path. hash null = deleted. */
export interface Head {
  path: string
  version: number // per-file counter, +1 on every accepted change
  hash: Hash | null
  seq: number // project-wide commit counter; clients resume from it after a disconnect
  device: string | null
  author: string | null
  at: number
}

/**
 * A client change: "the file held baseHash (server version baseVersion) and now holds hash".
 * hash null = deleted. baseHash is what the server merges against when it has moved on.
 */
export interface Op {
  opId: string // deterministic per (device, path, base, new): retries are recognised
  path: string
  baseVersion: number
  baseHash: Hash | null
  hash: Hash | null
}

export interface OpResult {
  // ok: applied (or nothing to do) · merged: combined with newer server content
  // conflict: could not merge, both kept · blocked: path has an open conflict
  status: 'ok' | 'merged' | 'conflict' | 'blocked' | 'error'
  version: number // server head after the op
  hash: Hash | null
  conflictId?: string
  error?: string
}

export interface Candidate {
  hash: Hash | null // null = this side deleted the file
  device: string | null
  author: string | null
  at: number
}

export interface Conflict {
  id: string
  path: string
  base: Hash | null
  a: Candidate // what the server already had
  b: Candidate // the later change that could not be merged into it
  votes: Record<string, 'A' | 'B'> // device -> choice
  status: 'open' | 'resolved'
  resolvedBy: string | null
  at: number
}

export interface Member {
  device: string
  name: string
  deviceName: string
  online: boolean
  owner?: boolean // created the project: can remove teammates
}

export type ServerMsg =
  | { type: 'hello'; seq: number; heads: Head[]; conflicts: Conflict[]; members: Member[] }
  | { type: 'change'; head: Head }
  | { type: 'conflict'; conflict: Conflict }
  | { type: 'members'; members: Member[] }
  | { type: 'ping' }

/** This Mac's network addresses: what teammates must use, since "localhost" means their own Mac. */
export const lanAddresses = () =>
  Object.values(networkInterfaces())
    .flatMap(list => list ?? [])
    .filter(a => a.family === 'IPv4' && !a.internal)
    .map(a => a.address)

export const HASH_RE = /^[0-9a-f]{64}$/
export const sha256 = (data: Uint8Array | string): Hash => createHash('sha256').update(data).digest('hex')

// ponytail: whole files go through memory; stream them if teams start syncing big media.
export const MAX_FILE = 100 * 1024 * 1024
