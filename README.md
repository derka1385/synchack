# SyncHack

Keeps one project folder in sync across a small team's Macs (2–4 people). Every teammate has a
real folder on disk. Claude Code, Codex, Cursor, VS Code, Finder, `npm run dev` and git all use
it as a normal folder. A background process uploads each saved change within about a second and
writes teammates' changes back into the same files. Concurrent edits to different parts of a file
merge automatically. Overlapping edits become a conflict that keeps both versions. Sync uses no AI
calls.

Status: phase 1 (sync engine) and phase 2 (CLI: create, import, join, modes, conflicts) work and
are tested, and a terminal interface (`synchack`) covers sharing, joining and day-to-day use.
Hosting Macs serve over TLS, pinned through the invite. Still to come: pairing codes.

## Quick start

Requires Node 24 or newer; tested on Node 26. It runs TypeScript directly, with no build step.

```sh
npm install
npm link        # optional: puts `synchack` on your PATH (else: node client-core/cli.ts)
synchack        # opens the terminal interface
```

1. **The creator** presses `n` and gives a folder (new or existing; its name becomes the project
   name). Their Mac now hosts the project, and an invite like `HX7-K92@192.168.1.129:8787#k3Jq…`
   is copied to the clipboard. The part after `#` identifies the creator's Mac (see Security).
   Invites work for 48 hours; `i` copies a fresh one.
2. **Teammates** run `synchack`, press `j` and paste the invite. The project lands in
   `~/<project name>`.
3. Everyone works normally in that folder: `claude`, `codex`, VS Code, Finder.

The interface shows each project, who is online, which files each teammate changed recently
(and what you are editing right now), live activity, and conflicts (`x` to review and resolve).
Keys: `n` share · `j` join · `i` copy invite · `u` copy install command · `l`/`c`/`p` live/calm/pause · `o` Finder · `x` conflicts · `q` quit.

Keep it open while you work: it is what syncs, and on the creator's Mac it is also the server.
Without the interface: `synchack create [dir]`, `synchack join INVITE [dir]`, `synchack run`.

| Command | What it does |
|---|---|
| `synchack status` | Projects, online/offline, pending files, teammates, open conflicts, errors |
| `synchack live` / `calm` / `pause` `[dir]` | Switch modes (see below) |
| `synchack conflicts` / `show ID` / `vote ID A\|B` / `resolve ID A\|B\|mine` | Review and settle conflicts |
| `synchack open [dir]` | Open the folder in Finder |
| `synchack invite [dir] [--new]` | Print the current invite; `--new` replaces it (the old one stops working) |
| `synchack members` / `remove NAME` / `leave` | List teammates; the creator removes one (this also replaces the invite); leave a project |
| `synchack history PATH` / `restore [PATH] [--version N]` | A file's versions; bring back missing files, or an old version of one |
| `synchack backup DEST` | Copy everything this Mac hosts, with full history |

The creator's Mac hosts on port 8787 (`SYNCHACK_PORT` to change; if a synchack server already
runs there, it is used). To use a separate server instead, e.g. a small VM, pass
`--server http://host:8787` (`npm run server` starts one). For Docker, use
`docker build -t synchack . && docker run -p 8787:8787 -v synchack:/data synchack`. A separate
server speaks plain HTTP unless given a certificate (`TLS_CERT`/`TLS_KEY` files, e.g. from
Let's Encrypt); put one in front of it before exposing it to the internet. Back it up while it
runs with `node server/backup.ts /data /data/backup-$(date +%F)`.

If a teammate can't connect, run `curl -k https://<creator-ip>:8787/health` on their Mac.
`{"ok":true}` means the network is fine. If it hangs, the Macs can't see each other: they are on
different networks, or the Wi-Fi isolates devices (common on school, eduroam and hotel
networks). A phone hotspot or Tailscale fixes that.

## Architecture

```
 Mac A                                    server                                   Mac B
 ~/SyncHack/MyProject (real files)        (Node + SQLite + blob dir)               ~/SyncHack/MyProject
   │ FSEvents (fs.watch recursive)          ┌──────────────────────────────┐          ▲ atomic write
   ▼                                        │ projects, members, join codes│          │ (temp file + rename)
 ProjectSync ── HTTP: blobs, ops ─────────► │ heads (current version/path) │ ── WS ──► ProjectSync
   │  per-file debounce, hashes             │ versions (full history)      │  change,
   │  serial queue, retry, reconnect        │ conflicts + votes            │  conflict,
 local SQLite: last synced                  │ content-addressed blobs      │  members
 (version, hash) per file                   └──────────────────────────────┘
```

- Client (`client-core/`): one `ProjectSync` per project. It watches the folder, debounces each
  file separately (400 ms in live mode), hashes, uploads batches, applies pushed changes, and
  reconnects with backoff. Local state lives in `~/Library/Application Support/SyncHack/state.db`
  (override with `$SYNCHACK_HOME`). Inside the project, only a hidden `.synchack/tmp/` is
  created (it holds its own `.gitignore`).
- Server (`server/`): the authority. Commands and file contents go over HTTP. A WebSocket per
  client pushes events. Every decision about an incoming change is made synchronously inside one
  SQLite transaction, so two Macs racing on the same file are always ordered.
- Shared (`shared/`): wire types, path validation, ignore rules, and the three-way merge.

## Repository

```
shared/protocol.ts    wire types (Head, Op, OpResult, Conflict, ServerMsg), sha256
shared/paths.ts       cleanPath (traversal-proof), ignore rules + defaults
shared/merge.ts       Myers diff + diff3 merge, binary detection
server/store.ts       SQLite schema, blob store, op handling (fast-forward / merge / conflict)
server/server.ts      HTTP(S) routes, WebSocket rooms, heartbeat, limits, logging
server/backup.ts      live backup of a server's data
client-core/state.ts  local SQLite (device id, projects, per-file synced state)
client-core/net.ts    HTTP(S) requests, certificate pinning, the hosting Mac's TLS identity
client-core/engine.ts ProjectSync: watcher, debounce, upload, download, reconnect, conflicts
client-core/hub.ts    syncs every project on this Mac, hosts the ones created here, invites
client-core/tui.ts    the terminal interface (Ink)
client-core/cli.ts    the synchack command
test/                 unit tests (merge, paths) and end-to-end sync tests
```

## Protocol

Bootstrap, no account needed (JSON bodies need `content-type: application/json`):

```
POST /api/projects  {name, device, user, deviceName}  → {projectId, code, token}
POST /api/join      {code, device, user, deviceName}  → {projectId, name, code, token}
```

The join code (`HX7-K92`) is not the project ID: project IDs are 128-bit random. Codes expire
after 48 hours. Each device gets its own 256-bit token, and the server stores only its hash. A
device that is already a member can only join again with its current token. Every call below
needs `Authorization: Bearer <token>`, and membership is checked on every request.

```
POST /api/p/:id/blobs/missing   {hashes}  → {missing}       which contents the server lacks
PUT  /api/p/:id/blobs/:sha256   raw bytes                   server verifies the hash
GET  /api/p/:id/blobs/:sha256
POST /api/p/:id/ops             {ops: Op[]} → {results}     applied in order
GET  /api/p/:id/heads | /history?path=P | /members | /conflicts | /conflicts/:cid
POST /api/p/:id/conflicts/:cid/vote     {choice: "A"|"B"}
POST /api/p/:id/conflicts/:cid/resolve  {choice: "A"|"B"}  or  {hash}  (hand-merged blob; null = delete)
POST /api/p/:id/invite          {rotate?}  → {code, expires}  current code; a new one if rotate or expired
DELETE /api/p/:id/members/:device           creator removes anyone, anyone removes themselves → {invite}
WS   /api/p/:id/ws?token=…&since=SEQ
     → hello {seq, heads changed since SEQ, open conflicts, members}
     → change {head} · conflict {conflict} · members {members} · ping
```

An op says "this file held `baseHash` (server version `baseVersion`) and now holds `hash`"
(`null` = deleted): `{opId, path, baseVersion, baseHash, hash}`.

## Versioning and conflict detection

Every path has a version that goes up by one for each accepted change, plus the project-wide
`seq` that clients resume from after a disconnect. Content is identified by its SHA-256, and
blobs are write-once and never deleted, so every past version stays recoverable. The server
handles each op like this:

| Situation | Result |
|---|---|
| `hash` equals `baseHash` or the current head | `ok`: nothing to change; the reply carries the head |
| The path has an open conflict | `blocked`: the client keeps the edit locally and retries once it is resolved |
| `baseHash` equals the head | `ok`: fast-forward to version + 1 |
| The server moved on since the client's base | three-way merge of base → client vs base → head: if clean, `merged` (version + 1); if not, `conflict` |
| The server has spent its merge budget | `busy`: the client sends the same op again 2 s later |

Nothing is ever last-write-wins. A `conflict` leaves the head untouched and stores the late change
as candidate B next to candidate A (the head), with author, device and time. Each Mac also keeps
its own version on disk. Delete vs edit, edit vs delete, the same new path created with different
content, and any concurrent binary change all become conflicts.

`opId` is a hash of (device, path, base, new content). If an upload's response is lost and the
client retries, the server recognises it and returns the original answer instead of creating a
spurious conflict.

## Three-way merge

`shared/merge.ts` is diff3 over lines, with line endings and BOM preserved byte for byte:

1. Myers diff, base → ours and base → theirs.
2. A base line kept by both sides is a sync point.
3. Between sync points, take whichever side changed. If both changed the stretch identically,
   take it once. If they changed it differently, it is a conflict. Adjacent lines count as
   overlapping, the same conservative rule git uses.

Text is UTF-8 without NUL bytes and under 4 MB. Anything else (png, pdf, sqlite, zip…) is never
text-merged. A diff with more than 2000 inserted plus deleted lines becomes a conflict rather than
a guess, and so does a server-side merge of more than 200 000 lines in total. Merges run on the
server's one thread, so they share a budget of about half its time; past it, ops come back `busy`. `synchack show ID` renders a conflict with git-style markers (`<<<<<<<`, `|||||||`,
`>>>>>>>`), so an agent can merge it by hand and run `synchack resolve ID mine`.

## Why sync never loops

Remote writes from Mac B never come back as uploads, because of one invariant. For every file,
the local DB stores the version and hash it was last in sync with:

- disk hash = stored hash → clean. A newer remote version may overwrite it.
- disk hash ≠ stored hash → local edits. Upload with `baseHash` = stored hash; the server merges.

When the client writes a teammate's change, it records the new hash first. The resulting FSEvent
then hashes to the same value and nothing is uploaded. This relies on content, not timing windows,
so a delayed or coalesced event cannot cause an echo. It also means touching a file without
changing it sends nothing. Pushed events whose version is not newer than the stored one
(duplicates, our own echo, out-of-order delivery) are ignored. All sync steps for a project run
one at a time on a serial queue, so an upload and a download of the same file never interleave.

Local edits are never overwritten. A remote change only touches a file that is clean, and the
check happens again right before the atomic rename. New files are created with `link()`, which
fails if a file appeared in the meantime.

## Ignore rules and secrets

Built in, always active:

```
node_modules/  dist/  build/  .next/  coverage/  *.log  .DS_Store
.env  .env.*  *.pem  *.key          ← secrets stay on the Mac that has them
._*  *.swp  *~                      ← OS/editor litter
.git/  .synchack/                   ← never synced, cannot be overridden
```

A `.synchackignore` at the project root adds gitignore-style rules (`*`, `**`, `?`, trailing `/`
for folders, leading `/` to anchor). It is synced, so the whole team shares it. A `!` line
re-includes a file, e.g. `!.env.example`. Ignored means invisible both ways: an ignored file is
never uploaded, and a teammate's file at an ignored path is never written here. Because the file
is shared, `!.env` would upload every teammate's `.env`, so don't. Git keeps working
independently: every Mac can still `git commit`/`push`, and sync never creates commits.

## Modes

- **live** (default): uploads 400 ms after the last change to a file. Teammates' changes are applied immediately.
- **calm**: same, but uploads wait for 15 s of quiet. Suited to when only one person is coding.
- **paused**: disconnected. Edits accumulate locally and nothing arrives. On resume, the client
  catches up on everything it missed, then uploads its own edits, which merge like any other
  concurrent change.

## Conflicts

```sh
synchack conflicts                 # id, path, who/when for A and B, votes
synchack show 7Hq2xK               # both sides with markers (or sizes, for binaries)
synchack vote 7Hq2xK B             # advisory: shown to everyone, never applied on its own
synchack resolve 7Hq2xK B          # A | B | mine (= the file on this Mac now, e.g. hand-merged)
```

While a conflict is open, that one file is held: each Mac keeps its own version and other files
keep syncing. Resolving commits the chosen content as a new version for everyone. Edits made
while the file was held are merged on top of the resolution, never dropped.

## Security

- **Transport.** A Mac that hosts makes a self-signed certificate once (in `$SYNCHACK_HOME/tls`).
  The invite carries the sha256 of its public key. Joining fetches the certificate, checks the
  key before sending anything, then trusts exactly that certificate for HTTP and WebSocket, so a
  machine pretending to be the host on the Wi-Fi never sees a code or token. The install command
  uses `curl --pinnedpubkey` with the same hash. Invites without `#…` (old ones, or a plain-HTTP
  server) still work, unencrypted.
- **Joining.** Invites expire after 48 h; `synchack invite --new` replaces one at once. Join and
  create attempts are limited to 20 per address per 10 minutes, and a hosting Mac only lets itself
  create projects. Nobody can take over a teammate by reusing their device id.
- **Members.** The creator removes a teammate with `synchack remove NAME`: their token stops
  working, their connection is closed, and the invite is replaced.
- **Limits.** Uploads stream to disk (100 MB per file, 16 at once) and count against a 5 GB quota
  per project (`SYNCHACK_QUOTA_GB` on a separate server). JSON bodies are capped at 2 MB, ops at
  1000 per request, WebSocket messages from clients at 4 KB.
- **Files that run.** Any member can change any synced file, including ones agents and tools
  execute (`.claude/`, `.vscode/`, `.github/workflows/`, `package.json`, `Makefile`, `.envrc`,
  `CLAUDE.md`…). Such changes from teammates are flagged with ⚠ in the activity log.
- **Logs.** The server logs one line per request, never tokens, to stdout or, on a hosting Mac,
  `$SYNCHACK_HOME/server.log`. Unexpected errors are logged in full and reported to clients only
  as "internal server error".

## Safety measures

- Every remote path goes through `cleanPath`: no `..`, absolute paths, empty segments, `.git`, or
  NUL. The client also refuses writes that would leave the folder through a symlinked directory.
- Uploaded blobs are verified against their hash, and downloads are verified before writing.
- If the project folder disappears (moved, unmounted), sync stops. It is never read as "everything was deleted".
- A file replaced by a folder (or the reverse), folder moves, and case-only renames on APFS
  (`uno.ts` → `Uno.ts`) propagate correctly.
- Synced files are never executed by synchack.
- Blobs are flushed to disk before they are committed, so a power cut can't leave a version
  pointing at an empty file.
- If one round would delete 50 or more files (or 10 or more and over half the project), not
  counting folder moves, sync pauses instead. `synchack live` sends the deletions; `synchack
  restore` brings the files back first.

## Dependencies

At runtime there are three dependencies: `ws` (WebSockets on both sides), plus `ink` and `react` for the terminal interface. Everything else
is built into Node: `node:sqlite`, `fs.watch` (FSEvents on macOS), `node:https`, `crypto`, and
`node:test`. Hosting over TLS uses the system `openssl` once, to sign the certificate. For development there are `typescript`, `@types/node` and `@types/ws`
(`npm run typecheck`).

## Tests

`npm test` runs 42 tests, including the terminal interface driven like a user. The end-to-end tests run a real server and one temp
folder with its own state DB per "Mac", with real FSEvents. They cover:

- Import with Unicode and space-containing names, nested folders, binaries and ignores; join; edits both ways
- Create, delete, rename, folder move, case-only rename, file ↔ folder swaps
- Save bursts (41 saves give 5 versions or fewer, B uploads nothing back)
- Merges: two Macs on different lines, and a three-Mac live race
- Conflicts: same line (3 Macs notified, both kept, votes, resolve), delete vs edit, same new path, binary
- Server outage with offline edits on both sides, then reconcile
- Edits made while the client was stopped
- Duplicate, stale and hostile pushed events (path traversal, symlink escape, `.git`)
- Paused and calm modes
- 1500 files imported and joined in about 2.5 s
- Mass deletions pausing sync, folder moves not counting as deletions, restore and old versions
- Pinned TLS end to end, and a server with another key never seeing the join code

`test/server.test.ts` checks the API directly: identity takeover, invite expiry and rotation,
member removal, rate limits, merge rationing, upload limits and quota, WebSocket limits, logging,
JSON content type and live backups. CI runs everything on macOS (Node 24 and 26) and the server
tests plus a Docker build on Linux.

The unit tests check the diff against a dynamic-programming reference on 5000 random cases, plus
merge identities, CRLF/BOM handling, and a 20 000-line merge.

## Known limits

- When a teammate's change is written, an agent write that lands in the same few microseconds
  (between the last check and the rename) is lost on that Mac.
- Empty folders, file permissions (the executable bit), and symlinks are not synced. Files over
  100 MB are skipped and listed in `synchack status`.
- Switching git branches inside a synced folder changes everyone's files. Pause first, or agree on it.
- Two different files whose names differ only by case, created on two Macs, are not detected as a clash.
- One server process with SQLite (move to Postgres before running several instances).
- Blobs are never deleted, so a project's storage only grows until its quota.

## Next

- Phase 3 desktop app. Recommendation: Electron, because the engine is Node and runs in the main
  process unchanged. Tauri would need a bundled Node sidecar or a Rust port of `client-core`.
  Screens: project list, create/import/join with a folder picker, mode switch, status, conflict
  review (A/B/markers, votes, resolve), members, Open in Finder.
- Optional `.synchack/team-state.json`: who is editing what, from recent uploads. It would live
  under `.synchack/`, so it can never feed the sync loop.
