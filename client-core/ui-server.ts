// The browser UI's backend: a small HTTP API over the Hub, on 127.0.0.1 only.
// Every API call carries a random per-launch token, and the Host header must be ours, so a
// web page open in the same browser can't drive it (CSRF, DNS rebinding).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import { cleanPath } from '../shared/paths.ts'
import { decode, isText, lcs } from '../shared/merge.ts'
import type { Hash } from '../shared/protocol.ts'
import { call, refuseRoot } from './engine.ts'
import { addFile, conflictText, installCommand, inviteFor, keepLocal, listFiles, previewLines, previewShare, refreshInvite, restore, setShared, type Hub } from './hub.ts'
import type { Project } from './state.ts'

const PAGE = new URL('./ui/index.html', import.meta.url)
const HOT_MS = 10 * 60_000
const RECENT_MS = 30 * 60_000

const tilde = (path: string) => path.replace(homedir(), '~')
const expand = (path: string) => resolve(String(path).replace(/^~(?=$|\/)/, homedir()))
const short = (author: string | null) => (author ?? '?').replace(/ \(.*\)$/, '')

/** Everything the page shows, in one JSON object. */
export function snapshot(hub: Hub) {
  const me = hub.state.device
  const now = Date.now()
  const projects = hub.state.projects().map(p => {
    const s = hub.engines.get(p.id)
    const members = s?.members.length ? s.members : [{ device: me, name: hub.state.identity().user, deviceName: hub.state.identity().deviceName, online: !!s?.online }]
    const editing = new Set(s?.editing() ?? [])
    const activity = [...(s?.activity ?? [])]
    const names = new Map(members.map(m => [m.device, m.device === me ? 'you' : m.name]))
    const files = (device: string) => {
      const recent = activity
        .flatMap(([path, edits]) => edits.filter(e => e.device === device && now - e.at < RECENT_MS).slice(0, 1).map(e => ({ path, at: e.at, deleted: e.deleted, editing: false })))
        .sort((a, b) => b.at - a.at)
      const live = device === me ? [...editing].map(path => ({ path, at: now, deleted: false, editing: true })) : []
      const seen = new Set<string>()
      return [...live, ...recent].filter(f => !seen.has(f.path) && seen.add(f.path)).slice(0, 4)
    }
    const conflicted = new Set([...(s?.conflicts.values() ?? [])].map(c => c.path))
    const hot = activity
      .map(([path, edits]) => {
        const people = new Set(edits.filter(e => now - e.at < HOT_MS).map(e => e.device))
        if (editing.has(path)) people.add(me)
        return { path, people: [...people].map(d => names.get(d) ?? '?') }
      })
      .filter(x => x.people.length > 1 && !conflicted.has(x.path))
    // last editor per path, for badges in the file tree
    const touched = Object.fromEntries(activity.map(([path, [e]]) => [path, { who: names.get(e.device) ?? short(e.author), at: e.at }]))
    return {
      id: p.id,
      name: p.name,
      root: tilde(p.root),
      mode: s?.mode ?? p.mode,
      online: !!s?.online,
      plain: !/^https:|^http:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(p.server), // files cross the network unencrypted
      pending: editing.size,
      invite: inviteFor(p),
      members: members.map(m => ({ device: m.device, name: m.name, deviceName: m.deviceName, online: m.online, you: m.device === me, owner: !!(m as { owner?: boolean }).owner, files: files(m.device) })),
      hot,
      touched,
      conflicts: [...(s?.conflicts.values() ?? [])].map(c => ({ id: c.id, path: c.path, a: { who: short(c.a.author), at: c.a.at, deleted: c.a.hash === null }, b: { who: short(c.b.author), at: c.b.at, deleted: c.b.hash === null }, votes: c.votes })),
      errors: Object.fromEntries(s?.errors ?? []),
      flagged: [...(s?.flagged ?? [])].map(([path, f]) => ({ path, who: f.author ? short(f.author) : null, at: f.at, why: f.why })),
      log: (hub.logs.get(p.id) ?? []).slice(-80),
    }
  })
  const teamOf = new Map<string, string[]>() // nearby instance -> projects they're in
  for (const p of projects) for (const m of p.members) teamOf.set(`${m.name} (${m.deviceName})`, [...(teamOf.get(`${m.name} (${m.deviceName})`) ?? []), p.id])
  return {
    me: { ...hub.state.identity(), device: me },
    hosting: hub.hosting ? { install: installCommand(hub.hosting.port, hub.hosting.cert), encrypted: !!hub.hosting.cert } : null,
    hostError: hub.hostError ?? null,
    projects,
    nearby: [...hub.nearby.keys()].sort().map(id => {
      const [, name = id, device = ''] = id.replace(/ \(\d+\)$/, '').match(/^(.*) \((.*)\)$/) ?? [] // Bonjour renames duplicates "… (2)"
      return { id, name, device, projects: teamOf.get(id) ?? [] }
    }),
    inbox: hub.inbox.map(i => ({ id: i.id, from: short(i.from), fromDevice: i.from, project: i.project, address: i.address, at: i.at })),
  }
}

/** What restoring would change: current file → that version, unchanged runs folded. */
export function lineDiff(now: string, then: string) {
  const split = (s: string) => (s === '' ? [] : s.replace(/\n$/, '').split('\n'))
  const a = split(now), b = split(then)
  const match = lcs(a, b) // a line kept by both, or -1
  const rows: { t: '=' | '-' | '+'; s: string }[] = []
  let j = 0
  a.forEach((line, i) => {
    if (match[i] < 0) return void rows.push({ t: '-', s: line })
    while (j < match[i]) rows.push({ t: '+', s: b[j++] })
    rows.push({ t: '=', s: line })
    j++
  })
  while (j < b.length) rows.push({ t: '+', s: b[j++] })
  // keep 3 lines of context around each change, fold the rest
  const near = rows.map((_, i) => rows.slice(Math.max(0, i - 3), i + 4).some(r => r.t !== '='))
  const out: { t: '=' | '-' | '+' | '…'; s: string }[] = []
  for (let i = 0; i < rows.length; i++) {
    if (near[i]) {
      out.push(rows[i])
      continue
    }
    let k = i
    while (k < rows.length && !near[k]) k++
    out.push({ t: '…', s: `${k - i} unchanged line${k - i === 1 ? '' : 's'}` })
    i = k - 1
  }
  return out
}

let picking = false

/**
 * The macOS folder picker (Finder's own window), or null when cancelled. The start folder goes in
 * as an argument, never into the script text, so no path can inject AppleScript.
 */
async function chooseFolder(start: string): Promise<string | null> {
  if (picking) throw new Fail('a Finder window is already open: pick a folder there or cancel it')
  picking = true
  try {
    const script = ['on run argv', 'activate', 'set f to choose folder with prompt "Choose the folder to share with SyncHack" default location (POSIX file (item 1 of argv))', 'return POSIX path of f', 'end run']
    const out = await new Promise<string | null>((ok, bad) =>
      execFile('osascript', [...script.flatMap(l => ['-e', l]), start], { timeout: 15 * 60_000 }, (err, stdout, stderr) => {
        if (!err) return ok(String(stdout).trim())
        if (/-128|cancel/i.test(String(stderr))) return ok(null) // the user pressed Cancel
        bad(new Fail(`couldn't open the Finder picker: ${String(stderr).trim() || err.message}`))
      }),
    )
    return out ? tilde(out.replace(/\/$/, '')) : null
  } finally {
    picking = false
  }
}

/** `open` arguments for a path inside a project: always reveal in Finder, never launch (bundles, scripts). */
export const openArgs = (target: string, _isDir: boolean) => ['-R', target]

class Fail extends Error {}

export async function startUi(hub: Hub, port = 0) {
  const token = randomBytes(18).toString('base64url')
  const project = (id: unknown): Project => hub.state.project(String(id)) ?? fail('no such project')
  const sync = (id: unknown) => hub.engines.get(project(id).id) ?? fail('that project is not syncing yet')
  const root = (b: Record<string, any>) => (b.project ? project(b.project).root : expand(b.root))
  const actions: Record<string, (b: Record<string, any>) => unknown> = {
    browse: b => {
      const want = expand(b.dir || '~')
      // A path that doesn't exist yet (being typed, or a new project's folder) lists the folder
      // it would be created in, and says so.
      let dir = want
      while (!existsSync(dir)) dir = dirname(dir)
      if (!statSync(dir).isDirectory()) fail(`${tilde(dir)} is a file, not a folder`)
      const entries = readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
        .map(e => ({ name: e.name, path: tilde(join(dir, e.name)) }))
        .sort((a, b) => a.name.localeCompare(b.name))
      return { dir: tilde(dir), parent: dir === '/' ? null : tilde(resolve(dir, '..')), entries, missing: dir === want ? undefined : tilde(want) }
    },
    pickFolder: async b => {
      const start = b.dir ? expand(b.dir) : homedir()
      return { path: await chooseFolder(existsSync(start) && statSync(start).isDirectory() ? start : homedir()) }
    },
    preview: b => {
      const dir = expand(b.dir)
      if (!existsSync(dir)) return { exists: false, empty: true, lines: [], entries: [] }
      refuseRoot(realpathSync(dir), realpathSync(hub.state.home)) // your home or a system folder: refused before any walk
      const empty = readdirSync(dir).every(f => f === '.DS_Store')
      return { exists: true, empty, lines: empty ? [] : previewLines(previewShare(dir)), entries: empty ? [] : listFiles(dir) }
    },
    create: async b => {
      const p = await hub.create(expand(b.dir))
      const invited = []
      for (const peer of (b.invite ?? []) as string[]) {
        try {
          invited.push({ peer, code: await hub.invite(p.id, peer) })
        } catch (e) {
          invited.push({ peer, error: (e as Error).message })
        }
      }
      return { id: p.id, name: p.name, invite: inviteFor(p), invited }
    },
    join: async b => {
      const p = await hub.join(String(b.invite))
      return { id: p.id, name: p.name, root: tilde(p.root) }
    },
    invite: async b => ({ code: await hub.invite(project(b.project).id, String(b.peer)) }),
    refreshInvite: async b => ({ invite: await refreshInvite(hub.state, project(b.project)) }),
    accept: async b => {
      const p = await hub.accept(String(b.id), String(b.code))
      return { id: p.id, name: p.name, root: tilde(p.root) }
    },
    dismiss: b => hub.dismiss(String(b.id)),
    dismissFlag: b => {
      const { flagged } = sync(b.project)
      b.path == null ? flagged.clear() : flagged.delete(String(b.path))
      hub.emit('update')
    },
    mode: b => {
      if (!['live', 'calm', 'paused'].includes(b.mode)) fail('mode is live, calm or paused')
      sync(b.project).setMode(b.mode)
    },
    open: b => {
      const base = project(b.project).root
      // the project folder opens; anything inside it is only revealed: "opening" a synced Tools.app would launch it
      spawn('open', b.path ? openArgs(join(base, cleanPath(b.path)), !!b.inside) : [base], { stdio: 'ignore', detached: true }).unref()
    },
    files: b => listFiles(root(b), b.dir ? String(b.dir) : ''),
    share: b => setShared(root(b), String(b.path), !!b.dir, !!b.shared),
    newFile: b => ({ path: addFile(project(b.project).root, String(b.path), typeof b.content === 'string' ? b.content : '') }),
    upload: b => ({ path: addFile(project(b.project).root, String(b.path), Buffer.from(String(b.data), 'base64')) }),
    conflictText: async b => {
      const p = project(b.project)
      const c = sync(b.project).conflicts.get(String(b.id)) ?? fail('that conflict is resolved')
      return { text: await conflictText(p, c) }
    },
    resolve: async b => {
      const p = project(b.project)
      const c = sync(b.project).conflicts.get(String(b.id)) ?? fail('that conflict is resolved')
      if (b.choice === 'mine') await keepLocal(p, c)
      else if (b.choice === 'A' || b.choice === 'B') await call(p, 'POST', `/conflicts/${c.id}/resolve`, { choice: b.choice })
      else fail('choose A, B or mine')
    },
    history: async b => {
      const p = project(b.project)
      const { versions } = await call(p, 'GET', `/history?path=${encodeURIComponent(cleanPath(b.path))}`)
      return { versions: (versions as { version: number; hash: Hash | null; author: string | null; at: number }[]).reverse().map(v => ({ ...v, author: short(v.author) })) }
    },
    version: async b => {
      // one version's content, and what restoring it would change in the file on this Mac
      const p = project(b.project)
      const path = cleanPath(b.path)
      const { versions } = await call(p, 'GET', `/history?path=${encodeURIComponent(path)}`)
      const v = (versions as { version: number; hash: Hash | null }[]).find(x => x.version === Number(b.version)) ?? fail('no such version')
      if (!v.hash) return { deleted: true }
      const bytes = (await call(p, 'GET', `/blobs/${v.hash}`)) as Buffer
      const file = join(p.root, path)
      const now = existsSync(file) ? readFileSync(file) : Buffer.alloc(0)
      if (!isText(bytes) || !isText(now)) return { binary: true, size: bytes.length, same: bytes.equals(now) }
      try {
        return { same: bytes.equals(now), diff: lineDiff(decode(now), decode(bytes)) }
      } catch {
        return { same: false, tooBig: true }
      }
    },
    restoreVersion: async b => {
      const p = project(b.project)
      const path = cleanPath(b.path)
      if (sync(b.project).editing().includes(path)) fail(`${path} has edits that aren't synced yet; try again in a second`)
      await restore(p, path, { version: Number(b.version), force: true }) // becomes a new version: the current one stays in history
      return { path }
    },
    deleted: async b => {
      const { heads } = await call(project(b.project), 'GET', '/heads')
      return {
        files: (heads as { path: string; hash: Hash | null; version: number; author: string | null; at: number }[])
          .filter(h => h.hash === null)
          .sort((x, y) => y.at - x.at)
          .slice(0, 100)
          .map(h => ({ path: h.path, version: h.version, author: short(h.author), at: h.at })),
      }
    },
    restoreDeleted: async b => {
      const restored = await restore(project(b.project), cleanPath(b.path)) // its last content, as a new version
      if (!restored.length) fail('nothing to restore (it exists on this Mac, or never had content)')
      return { path: restored[0] }
    },
    vote: async b => {
      if (b.choice !== 'A' && b.choice !== 'B') fail('vote A or B')
      await call(project(b.project), 'POST', `/conflicts/${String(b.id)}/vote`, { choice: b.choice })
    },
  }

  const http = createServer((req, res) => {
    route(req, res).catch(e => send(res, e instanceof Fail ? 400 : 500, { error: (e as Error).message }))
  })
  let address = ''
  const authorized = (req: IncomingMessage, url: URL) => {
    if (req.headers.host !== address) return false // DNS rebinding: only our own address
    const given = Buffer.from(String(req.headers['x-token'] ?? url.searchParams.get('t') ?? ''))
    return given.length === token.length && timingSafeEqual(given, Buffer.from(token))
  }
  const clients = new Set<ServerResponse>()

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x')
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:" })
      return void res.end(readFileSync(PAGE))
    }
    if (!authorized(req, url)) return send(res, 403, { error: 'forbidden' })
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      res.write(`data: ${JSON.stringify(snapshot(hub))}\n\n`)
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }
    const action = req.method === 'POST' && url.pathname.startsWith('/api/') ? actions[url.pathname.slice(5)] : undefined
    if (!action) return send(res, 404, { error: 'not found' })
    const chunks: Buffer[] = []
    let size = 0
    for await (const c of req as AsyncIterable<Buffer>) {
      if ((size += c.length) > 40 * 1024 * 1024) return send(res, 413, { error: 'too large (max 30 MB per file)' })
      chunks.push(c)
    }
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    send(res, 200, (await action(body)) ?? { ok: true })
    push()
  }

  // live updates, at most every 250 ms
  let queued = false
  const push = () => {
    if (queued || !clients.size) return
    queued = true
    setTimeout(() => {
      queued = false
      const data = `data: ${JSON.stringify(snapshot(hub))}\n\n`
      for (const c of clients) c.write(data)
    }, 250)
  }
  hub.on('update', push)
  const clock = setInterval(push, 2000) // "12s ago" keeps moving

  await new Promise<void>((ok, bad) => http.once('error', bad).listen(port, '127.0.0.1', ok))
  address = `127.0.0.1:${(http.address() as AddressInfo).port}`
  return {
    url: `http://${address}/#t=${token}`,
    token,
    address,
    async close() {
      clearInterval(clock)
      hub.off('update', push)
      for (const c of clients) c.end()
      http.closeAllConnections()
      await new Promise(r => http.close(r))
    },
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return void res.end()
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function fail(message: string): never {
  throw new Fail(message)
}

