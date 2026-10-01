// HTTP for commands and blobs, one WebSocket per client for pushed events.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createTlsServer } from 'node:https'
import { createHash as hashOf, X509Certificate } from 'node:crypto'
import { createReadStream, readFileSync, rmSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import { HASH_RE, MAX_FILE, lanAddresses, type Member, type ServerMsg } from '../shared/protocol.ts'
import { Store, type Device } from './store.ts'

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export interface Server {
  url: string
  port: number
  /** With TLS: the certificate (PEM) and the sha256 of its public key that clients pin. */
  cert?: string
  pin?: string
  store: Store
  close(): Promise<void>
}

export interface ServerOptions {
  port?: number
  dataDir?: string
  /** Only this machine may create projects: true when a creator's Mac hosts (the Hub). */
  localCreateOnly?: boolean
  /** Join and create attempts allowed per address per window. Loopback is exempt unless `limitLoopback`. */
  rateLimit?: { max: number; windowMs: number; limitLoopback?: boolean }
  /** Blob storage per project, in bytes. */
  quota?: number
  /** One line per request and every server error. Default: silent. */
  log?: (line: string) => void
  /** Serve HTTPS with this key and certificate (PEM). */
  tls?: { key: string; cert: string }
}

const MAX_UPLOADS = 16 // blob uploads in flight at once, across all clients
const MAX_JSON = 2 * 1024 * 1024 // 1000 ops is about 300 KB

export async function startServer({ port = 8787, dataDir = 'data', localCreateOnly = false, rateLimit = { max: 20, windowMs: 10 * 60_000 }, quota, log = () => {}, tls }: ServerOptions = {}): Promise<Server> {
  const pin = tls && hashOf('sha256').update(new X509Certificate(tls.cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64')
  const store = new Store(dataDir, { quota })
  let uploads = 0
  const limiter = new RateLimit(rateLimit.max, rateLimit.windowMs)
  const rooms = new Map<string, Map<WebSocket, { me: Device; alive: boolean }>>()
  let closing = false

  const send = (project: string, msg: ServerMsg) => {
    const s = JSON.stringify(msg)
    for (const ws of rooms.get(project)?.keys() ?? []) ws.send(s)
  }
  const members = (project: string): Member[] => {
    const online = new Set([...(rooms.get(project)?.values() ?? [])].map(s => s.me.device))
    return store.members(project).map(m => ({ ...m, online: online.has(m.device) }))
  }

  const caller = new WeakMap<IncomingMessage, Device>()
  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const start = Date.now()
    res.on('close', () => {
      const me = caller.get(req)
      log(`${req.method} ${routeName(req.url)} ${res.statusCode} ${Date.now() - start}ms ${req.socket.remoteAddress ?? '-'}${me ? ` ${me.project} ${me.name} (${me.deviceName})` : ''}`)
    })
    route(req, res).catch(e => {
      const status = e.status ?? (e instanceof SyntaxError ? 400 : 500)
      // Unexpected errors are logged in full and never shown to callers.
      if (status >= 500 && !e.status) log(`error in ${req.method} ${routeName(req.url)}: ${e.stack ?? e}`)
      if (res.headersSent) return res.destroy()
      reply(res, status, { error: status >= 500 && !e.status ? 'internal server error' : e.message })
    })
  }
  const http = tls ? createTlsServer({ key: tls.key, cert: tls.cert }, handle) : createServer(handle)

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x')
    const key = `${req.method} ${url.pathname}`
    if (key === 'GET /health') return reply(res, 200, { ok: true })
    // Teammates install synchack from this Mac: curl -fsSL http://<ip>:8787/install | sh
    if (key === 'GET /install') {
      res.writeHead(200, { 'content-type': 'text/x-shellscript' })
      const host = /^[\w.:[\]-]{1,255}$/.test(req.headers.host ?? '') ? req.headers.host : `localhost:${actual}`
      return void res.end(installScript(`${tls ? 'https' : 'http'}://${host}`, pin))
    }
    if (key === 'GET /install.tgz') {
      res.writeHead(200, { 'content-type': 'application/gzip' })
      const tar = spawn('tar', ['-cz', '-C', APP, 'package.json', 'package-lock.json', 'shared', 'server', 'client-core'], { stdio: ['ignore', 'pipe', 'ignore'] })
      tar.on('error', e => log(`install.tgz: ${e.message}`)) // e.g. no tar: the download just fails
      return void pipeline(tar.stdout, res).catch(() => tar.kill())
    }
    if (key === 'POST /api/projects' || key === 'POST /api/join') {
      const ip = req.socket.remoteAddress ?? ''
      const local = isLoopback(ip)
      if (key === 'POST /api/projects' && localCreateOnly && !local) throw new HttpError(403, 'projects can only be created on the Mac that hosts them')
      if (!(local && !rateLimit.limitLoopback)) {
        const wait = limiter.take(ip)
        if (wait) {
          res.setHeader('retry-after', String(Math.ceil(wait / 1000)))
          throw new HttpError(429, `too many attempts; try again in ${Math.ceil(wait / 60_000)} min`)
        }
      }
      const b = await json(req)
      if (key === 'POST /api/projects') return reply(res, 200, store.createProject(text(b.name, 'name'), who(b)))
      const r = store.join(text(b.code, 'code'), who(b), bearer(req))
      if (!r) throw new HttpError(404, 'unknown or expired invite')
      return reply(res, 200, r)
    }

    const m = url.pathname.match(/^\/api\/p\/([\w-]{1,64})(\/.*)$/)
    if (!m) throw new HttpError(404, 'not found')
    const [, project, rest] = m
    const me = store.auth(project, bearer(req))
    if (!me) throw new HttpError(401, 'not a member of this project')
    caller.set(req, me)

    if (rest === '/ops' && req.method === 'POST') {
      const { ops } = await json(req)
      if (!Array.isArray(ops) || ops.length > 1000) throw new HttpError(400, 'ops must be an array of at most 1000')
      const { results, events } = store.applyOps(me, ops)
      for (const e of events) send(project, e)
      return reply(res, 200, { results })
    }
    if (rest === '/blobs/missing' && req.method === 'POST') {
      const { hashes } = await json(req)
      if (!Array.isArray(hashes) || hashes.length > 1000) throw new HttpError(400, 'hashes must be an array of at most 1000')
      return reply(res, 200, { missing: hashes.filter(h => typeof h === 'string' && HASH_RE.test(h) && !store.hasBlob(project, h)) })
    }
    const blob = rest.match(/^\/blobs\/([0-9a-f]{64})$/)?.[1]
    if (blob && req.method === 'PUT') {
      const size = Number(req.headers['content-length'] ?? 0)
      if (size > MAX_FILE) throw new HttpError(413, 'too large')
      if (store.hasBlob(project, blob)) {
        req.resume()
        return reply(res, 204)
      }
      store.reserve(project, size)
      if (uploads >= MAX_UPLOADS) throw new HttpError(503, 'too many uploads at once; retry shortly')
      uploads++
      try {
        await receiveBlob(req, project, blob)
      } finally {
        uploads--
      }
      return reply(res, 204)
    }
    if (blob && req.method === 'GET') {
      if (!store.hasBlob(project, blob)) throw new HttpError(404, 'no such blob')
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      return void pipeline(createReadStream(store.blobPath(project, blob)), res).catch(() => res.destroy())
    }
    if (rest === '/conflicts' && req.method === 'GET') return reply(res, 200, { conflicts: store.conflicts(project, url.searchParams.has('all')) })
    const c = rest.match(/^\/conflicts\/([\w-]{1,64})(?:\/(vote|resolve))?$/)
    if (c && !c[2] && req.method === 'GET') {
      const conflict = store.conflict(project, c[1])
      if (!conflict) throw new HttpError(404, 'no such conflict')
      return reply(res, 200, conflict)
    }
    if (c?.[2] === 'vote' && req.method === 'POST') {
      const { choice } = await json(req)
      if (choice !== 'A' && choice !== 'B') throw new HttpError(400, 'choice must be A or B')
      const conflict = store.vote(me, c[1], choice)
      send(project, { type: 'conflict', conflict })
      return reply(res, 200, conflict)
    }
    if (c?.[2] === 'resolve' && req.method === 'POST') {
      const b = await json(req)
      if (b.choice !== undefined && b.choice !== 'A' && b.choice !== 'B') throw new HttpError(400, 'choice must be A or B')
      if (b.hash !== undefined && b.hash !== null && !HASH_RE.test(b.hash)) throw new HttpError(400, 'bad hash')
      const r = store.resolve(me, c[1], b)
      send(project, { type: 'change', head: r.head })
      send(project, { type: 'conflict', conflict: r.conflict })
      return reply(res, 200, r)
    }
    if (rest === '/heads' && req.method === 'GET') return reply(res, 200, { heads: store.heads(project) })
    if (rest === '/history' && req.method === 'GET') return reply(res, 200, { versions: store.history(project, url.searchParams.get('path') ?? '') })
    if (rest === '/members' && req.method === 'GET') return reply(res, 200, { members: members(project) })
    if (rest === '/invite' && req.method === 'POST') {
      const { rotate } = await json(req)
      return reply(res, 200, store.invite(project, rotate === true))
    }
    const gone = rest.match(/^\/members\/([^/]{1,200})$/)?.[1]
    if (gone && req.method === 'DELETE') {
      const device = decodeURIComponent(gone)
      const invite = store.removeMember(me, device)
      for (const [ws, s] of rooms.get(project) ?? []) if (s.me.device === device) ws.close(4001, 'removed from the project')
      send(project, { type: 'members', members: members(project) })
      return reply(res, 200, { invite })
    }
    throw new HttpError(404, 'not found')
  }

  /** Streams an upload to disk while hashing it, so a 100 MB file never sits in memory. */
  async function receiveBlob(req: IncomingMessage, project: string, hash: string) {
    const tmp = store.tempPath()
    const digest = createHash('sha256')
    let size = 0
    try {
      const fh = await open(tmp, 'w')
      try {
        for await (const chunk of req as AsyncIterable<Buffer>) {
          size += chunk.length
          if (size > MAX_FILE) throw new HttpError(413, 'too large')
          digest.update(chunk)
          await fh.write(chunk)
        }
        await fh.sync()
      } finally {
        await fh.close()
      }
      if (digest.digest('hex') !== hash) throw new HttpError(400, 'content does not match its hash')
      store.adoptBlob(project, tmp, hash, size, true)
    } catch (e) {
      rmSync(tmp, { force: true })
      throw e
    }
  }

  // Clients never send anything but pongs, so any real message is refused.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 })
  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const project = url.pathname.match(/^\/api\/p\/([\w-]{1,64})\/ws$/)?.[1]
    const me = project ? store.auth(project, url.searchParams.get('token')) : undefined
    if (!me) return void socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    wss.handleUpgrade(req, socket, head, ws => {
      const room = rooms.get(me.project) ?? new Map()
      rooms.set(me.project, room)
      room.set(ws, { me, alive: true })
      // Same tick as joining the room: nothing committed in between can be missed.
      const since = Number(url.searchParams.get('since')) || 0
      const hello: ServerMsg = { type: 'hello', seq: store.seq(me.project), heads: store.heads(me.project, since), conflicts: store.conflicts(me.project), members: members(me.project) }
      ws.send(JSON.stringify(hello))
      send(me.project, { type: 'members', members: members(me.project) })
      ws.on('error', () => ws.terminate()) // e.g. an oversized message; without a listener it would crash the server
      ws.on('pong', () => {
        const s = room.get(ws)
        if (s) s.alive = true
      })
      ws.on('close', () => {
        room.delete(ws)
        if (!room.size && rooms.get(me.project) === room) rooms.delete(me.project)
        if (!closing) send(me.project, { type: 'members', members: members(me.project) })
      })
    })
  })

  // Protocol pings find dead clients; the JSON ping lets clients notice a dead server.
  const beat = setInterval(() => {
    for (const room of rooms.values())
      for (const [ws, s] of room) {
        if (!s.alive) {
          ws.terminate()
          continue
        }
        s.alive = false
        ws.ping()
        ws.send('{"type":"ping"}')
      }
  }, 20_000)

  let actual = port
  try {
    await new Promise<void>((ok, fail) => http.once('error', fail).listen(port, ok))
  } catch (e) {
    clearInterval(beat)
    store.db.close()
    throw e // e.g. EADDRINUSE: the caller decides whether that's fine
  }
  actual = (http.address() as AddressInfo).port
  return {
    url: `${tls ? 'https' : 'http'}://localhost:${actual}`,
    port: actual,
    cert: tls?.cert,
    pin,
    store,
    async close() {
      closing = true
      clearInterval(beat)
      for (const room of rooms.values()) for (const ws of room.keys()) ws.terminate()
      wss.close()
      http.closeAllConnections()
      await new Promise(r => http.close(r))
      store.db.close()
    },
  }
}

const APP = fileURLToPath(new URL('..', import.meta.url))

// Plain sh: installs into ~/.synchack-app (outside node_modules, so Node runs the TypeScript as is)
// and adds `synchack` and `/synchack` to ~/.zshrc. Running it again updates.
const installScript = (src: string, pin?: string) => `#!/bin/sh
set -e
if ! command -v node >/dev/null 2>&1; then
  echo "synchack needs Node 24 or newer: install it from https://nodejs.org, then run this again."; exit 1
fi
if [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 24 ]; then
  echo "synchack needs Node 24 or newer (you have $(node -v)): update it from https://nodejs.org"; exit 1
fi
APP="$HOME/.synchack-app"
echo "Downloading synchack from ${src} ..."
rm -rf "$APP" && mkdir -p "$APP"
curl -fsSL ${pin ? `-k --pinnedpubkey 'sha256//${pin}' ` : ''}"${src}/install.tgz" | tar -xz -C "$APP"
(cd "$APP" && npm install --omit=dev --no-audit --no-fund --no-update-notifier --loglevel=error)
if ! grep -q 'synchack-app' "$HOME/.zshrc" 2>/dev/null; then
  printf '\n# SyncHack\nsynchack() { node "$HOME/.synchack-app/client-core/cli.ts" "$@" }\n/synchack() { synchack "$@" }\n' >> "$HOME/.zshrc"
fi
echo "Done. Open a new Terminal window and type: /synchack"
`

/** The route without ids or hashes, for logs. */
const routeName = (url = '/') =>
  url.split('?')[0].replace(/^\/api\/p\/[^/]+/, '/api/p/:id').replace(/[0-9a-f]{64}/, ':hash').replace(/\/(conflicts|members)\/[^/]+/, '/$1/:id')

const bearer = (req: IncomingMessage) => req.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ?? null
const isLoopback = (ip: string) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'

/** Fixed window per address. take() returns 0 when allowed, else ms until the window resets. */
class RateLimit {
  private hits = new Map<string, { n: number; reset: number }>()
  private max: number
  private windowMs: number
  constructor(max: number, windowMs: number) {
    this.max = max
    this.windowMs = windowMs
  }
  take(key: string) {
    const now = Date.now()
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k)
    const h = this.hits.get(key)
    if (!h || h.reset <= now) {
      this.hits.set(key, { n: 1, reset: now + this.windowMs })
      return 0
    }
    return ++h.n > this.max ? h.reset - now : 0
  }
}

function reply(res: ServerResponse, status: number, body?: unknown) {
  res.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' })
  res.end(body === undefined ? undefined : JSON.stringify(body))
}

async function body(req: IncomingMessage, limit: number) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, 'too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function json(req: IncomingMessage) {
  const v = JSON.parse((await body(req, MAX_JSON)).toString() || '{}')
  if (!v || typeof v !== 'object') throw new HttpError(400, 'expected a JSON object')
  return v as Record<string, any>
}

function text(v: unknown, field: string) {
  if (typeof v !== 'string' || !v.trim() || v.length > 200) throw new HttpError(400, `${field} must be a short string`)
  return v.trim()
}

const who = (b: Record<string, unknown>) => ({ device: text(b.device, 'device'), name: text(b.user, 'user'), deviceName: text(b.deviceName, 'deviceName') })

if (import.meta.main) {
  const stamp = (line: string) => `${new Date().toISOString()} ${line}`
  const s = await startServer({
    port: Number(process.env.PORT ?? 8787),
    dataDir: process.env.DATA_DIR ?? 'data',
    quota: process.env.SYNCHACK_QUOTA_GB ? Number(process.env.SYNCHACK_QUOTA_GB) * 1024 ** 3 : undefined,
    log: line => console.log(stamp(line)),
    // A certificate from a real CA (or your proxy's) keeps clients on their system trust store.
    tls: process.env.TLS_CERT && process.env.TLS_KEY ? { cert: readFileSync(process.env.TLS_CERT, 'utf8'), key: readFileSync(process.env.TLS_KEY, 'utf8') } : undefined,
  })
  let stopping = false
  const stop = (why: string, code = 0) => {
    if (stopping) return
    stopping = true
    console.log(stamp(`${why}; shutting down`))
    void s.close().finally(() => process.exit(code))
    setTimeout(() => process.exit(code), 5000).unref()
  }
  process.once('SIGTERM', () => stop('SIGTERM'))
  process.once('SIGINT', () => stop('SIGINT'))
  // State may be inconsistent after an unexpected throw: log it, close the database, exit, and let the supervisor restart us.
  process.on('uncaughtException', e => {
    console.error(stamp(`uncaught: ${e.stack ?? e}`))
    stop('uncaught exception', 1)
  })
  const lan = lanAddresses().map(ip => `${s.cert ? 'https' : 'http'}://${ip}:${s.port}`)
  console.log(`synchack server listening on port ${s.port}, all interfaces (data in ${process.env.DATA_DIR ?? 'data'})`)
  console.log(lan.length ? `teammates connect with:  --server ${lan.join('   or   ')}` : 'no network address: only this Mac can connect')
}
