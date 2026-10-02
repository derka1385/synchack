# SyncHack security audit

Date: 2026-10-01 · Scope: the whole repository (`server/`, `client-core/` including the local web
UI, `shared/`, the installer, the Dockerfile, dependencies). There is no Electron app; the desktop
interface is a local web page served by `client-core/ui-server.ts`.

Method: a full read of every trust boundary, then attacks run against a local server and local
clients (never against external systems). Each confirmed issue has a regression test in
`test/security.test.ts`. Those tests failed before the fixes and pass after them.

## Summary

The core design is sound:
- **Authorization:** every project route and the WebSocket check membership by token.
- **Writes and paths:** remote writes are canonicalized and never pass through symlinks.
- **Merges and history:** nothing is last-write-wins, and history keeps every version.
- **Oliver's earlier hardening:** expiring invites, rate limits, quotas, pinned TLS, CSRF protection.

The audit found 2 High issues in the code plus 1 High found while reading the path rules, all
three about secrets or availability, and a set of Medium and Low gaps. Every finding is fixed,
Low included: the five Low findings first accepted were fixed in a follow-up the same day
(SEC-21 to SEC-25). What remains is by design and documented below: teammates can change code,
and the host is trusted.

| Severity | Found | Fixed | Mitigated | By design / no action |
|---|---|---|---|---|
| Critical | 0 | — | — | — |
| High | 3 | 3 | — | — |
| Medium | 9 | 9 | — | — |
| Low | 11 | 11 | — | — |
| Informational | 8 | 1 (trash) | 3 (review notices, encryption label, discovery opt-out) | 4 |

Threat model used: (1) a malicious teammate, (2) someone on the same Wi-Fi, (3) someone holding
or guessing an invite code, (4) a modified client sending malformed protocol messages, (5) a
hostile synced project (names, symlinks, huge files), (6) attempts to escape the project folder,
(7) an internet attacker when the server is exposed. **The hosting server is trusted**: it holds
every file and every version by design.

## Findings

### High

**SYNC-H1: a teammate can collect everyone's secrets through `.synchackignore`** · Fixed (SEC-01)
- Component: `shared/paths.ts` (ignore rules), client engine.
- Attack scenario: `.synchackignore` is synced, and `!` re-includes ignored files. A teammate
  publishes `!.env` and `!*.pem`. Every other Mac reloads the rules and uploads its own `.env`
  and keys, which the attacker then downloads.
- Evidence: the exploit test put a victim's `.env` and `deploy.pem` on the server.
- Exploitability: trivial for any member.
- Impact: credentials of every teammate.
- Fix: secrets are enforced by `secret()`, which runs after all rules, cannot be negated, and
  ignores letter case. Templates (`.env.example`, `.sample`, `.template`, `.dist`, `.defaults`)
  still sync.

**SYNC-H2: anyone on the network can crash the server with one request** · Fixed (SEC-20)
- Component: `server/server.ts`, the request logger.
- Attack scenario: send an oversized body to `/api/join`, `/api/projects` or `/inbox`. No token
  is needed. When the refused request's connection is torn down, `req.socket` becomes `null`,
  and the log listener throws an uncaught exception.
- Evidence: reproduced as `SERVER CRASHED (uncaught): Cannot read properties of null (reading 'remoteAddress')`.
- Exploitability: one HTTP request from the LAN, or from the internet if exposed; repeatable.
- Impact: the hosting Mac's synchack (or the standalone server) stops, and sync stops for the whole team.
- Fix: the address is captured when the request arrives, and logging can no longer throw.

**SYNC-H3: `.git` reachable through letter case** · Fixed (SEC-19)
- Component: `cleanPath`, ignore rules.
- Attack scenario: only the exact names `.git` and `.synchack` were blocked, but APFS is
  case-insensitive. A teammate publishes `.GIT/config`. On the victim's Mac that path is the real
  `.git/config`. The engine finds an untracked file there, uploads it as a conflict candidate the
  attacker can read (remote URLs often embed tokens), and can create new files inside `.git`.
- Evidence: by code reading. `cleanPath('.GIT/config')` was accepted; it is now refused in tests.
- Impact: git credential disclosure, and tampering inside `.git`.
- Fix: reserved names are compared case-insensitively everywhere, and all ignore rules now match
  without regard to case.

### Medium

**SYNC-M1: operation-ID squatting silently drops a teammate's change** · Fixed (SEC-05)
- Attack scenario: op IDs are predictable, and the server deduplicated retries by op ID alone. A
  member submits a harmless op carrying the victim's *next* op ID, for example the deletion of a
  file. The victim's real op is then answered with the attacker's result, and its change never
  reaches the server.
- Evidence: in the exploit test the deletion never arrived (timeout).
- Fix: op IDs are namespaced by the authenticated device on the server (`device\nopId`).

**SYNC-M2: files behind a symlinked folder were read and uploaded** · Fixed (SEC-12)
- Attack scenario: a tracked folder is replaced by a symlink to, say, `~/.ssh`. That takes a local
  action, such as a script a teammate got someone to run. The engine then read `conf/id` through
  the link and uploaded the private key.
- Evidence: the exploit test found the key's content on the server.
- Fix: reads verify that the real path stays inside the project, and refuse (without deleting
  anything) otherwise.

**SYNC-M3: restore, keep-my-file and share toggles followed a symlink at the file itself** · Fixed (SEC-13)
- Attack scenario: `synchack restore notes.md --version N --force` on a `notes.md` that is a link
  to `~/.zshrc` wrote the teammate-controlled version into `~/.zshrc`. Keep-my-file could upload
  a linked secret, and a linked `.synchackignore` could be overwritten through the link.
- Evidence: the exploit test overwrote a file outside the project.
- Fix: these paths require a regular file, and writes rename a temp file over the target, which
  replaces a link rather than following it.

**SYNC-M4: a home or system folder could be shared, and its preview froze synchack** · Fixed (SEC-03, SEC-04)
- Attack scenario (also a usability bug you hit, with `/Users`): previewing walked the whole tree
  synchronously, so the process stalled for minutes. Creating the project would then have
  published a home folder, including `~/.ssh/id_rsa`, which was not ignored.
- Fix: `refuseRoot()` rejects `/`, `/Users`, system folders, the home folder and its parents,
  `~/Library`, and synchack's own data folder, for sharing and joining alike (CLI, terminal
  interface and app). The preview stops after 20 000 entries and says so.

**SYNC-M5: secret file names were only partly covered** · Fixed (SEC-02)
- Before: `.ENV`, `id_rsa`, `id_ed25519`, `*.p12`, `*.pfx`, `.ssh/`, `.aws/` and `.netrc` all synced.
- Fix: these are now covered by the non-overridable secret rule, in any letter case.

**SYNC-M6: 6-character invite codes, and an IPv6 rate-limit bypass** · Fixed (SEC-07)
- Analysis: 31⁶ ≈ 2^29.7. The per-address limit (20 per 10 minutes) is solid for IPv4, but one
  IPv6 host can rotate through a whole /64. Against an internet-exposed server, about 2000
  guesses/s for 48 h covers about 39 % of the code space.
- Fix: codes are now 8 characters, `XXXX-XXXX` (31⁸ ≈ 2^39.6, which brings the 48 h odds above
  under 0.05 %), and IPv6 clients are limited per /64. Existing 6-character codes keep working
  until they expire.

**SYNC-M7: terminal escape injection through names and paths** · Fixed (SEC-06)
- Attack scenario: display names, file paths and Bonjour names reached the CLI and terminal
  interface unfiltered. A teammate named `\x1b]52;…` could rewrite the screen or, in terminals
  that allow it, the clipboard.
- Fix: the server rejects control characters in names and paths. Clients strip them from
  everything they print, including server-sent names and conflict authors. Bonjour names that
  contain control characters, or are longer than 120 characters, are dropped.

**SYNC-M8: storage quota bypass with chunked uploads** · Fixed (SEC-10)
- The quota was checked against the declared `Content-Length`. A chunked upload declares none,
  so it skipped the check entirely, which allowed unlimited storage per member.
- Evidence: a 5000-byte upload was accepted with a 1000-byte quota.
- Fix: bytes are counted while streaming, and the upload stops at the quota (507).

**SYNC-M9: no rate limit behind a reverse proxy** · Fixed
- Attack scenario: loopback was exempt from the join limit. Behind a proxy on the same host,
  every client arrives from loopback, so code guessing was unlimited.
- Fix: the standalone server (`npm run server`, Docker) rate-limits loopback too. The hosting Mac
  still exempts itself, because it creates projects locally.

### Low

| ID | Finding | Status |
|---|---|---|
| SYNC-L1 | `DELETE /members/<bad %-encoding>` returned 500 | Fixed: 400 (SEC-09) |
| SYNC-L2 | A symlinked `.synchack` made start-up `rm -rf` its target's `tmp/` | Fixed: refused (SEC-14) |
| SYNC-L3 | Local state (project tokens) was readable by other users of the Mac (0755/0644) | Fixed: 0700/0600 (SEC-17) |
| SYNC-L4 | Invitations could be aimed at any name; `dns-sd` got it as an argument (argv, no shell) | Fixed: discovered peers only (SEC-18) |
| SYNC-L5 | WebSocket token in the URL, where proxy access logs keep it | Fixed: `Authorization` header (query still accepted) |
| SYNC-L6 | "Open" on a synced folder named `Tools.app` used `open` (launch); project folders were named from the server | Fixed: reveal only, sanitized folder names (SEC-16). Exec bits are never synced, so a synced bundle would not have run anyway |
| SYNC-L7 | Display names aren't unique: a teammate can call themselves "Nolann" | Fixed: names are unique per project, ignoring case and width: a second "nolann" or "ＮＯＬＡＮＮ" gets a number ("nolann 2") (SEC-21) |
| SYNC-L8 | `A.txt` and `a.txt` from two teammates: on APFS both are one file, so the second was never written and stayed out of sync | Fixed: the server refuses a file whose name differs only in case from an existing one and asks to rename it. Case-only renames still sync: clients send deletions first (SEC-22) |
| SYNC-L9 | Anyone on the Wi-Fi can push invitation cards (20 per 10 minutes, 20 kept) and replace a pending one with the same name | Fixed: one network address keeps at most 3 cards and can only replace its own; a repeated invitation is ignored (SEC-23). A forged invitation still can never be joined |
| SYNC-L10 | Member-level resource abuse: unlimited version rows and WebSockets, slow uploads holding the 16 upload slots, `since=0` reconnect loops | Fixed: per device, 50 000 file changes and 60 connections per 10 minutes, 3 open sockets (the oldest give way) and 8 of the 16 upload slots (SEC-24) |
| SYNC-L11 | A hostile `.synchackignore` can hide files (for example `*`) and stop sync for everyone | Fixed: when a teammate's rules stop files from syncing, the app shows who changed them and how many files, with "Review change" (SEC-25). Hiding files stays possible: that is what the file is for |

### Informational

- **Teammates can push code** (mitigated, by design). That is the product: a teammate can change
  `package.json` scripts, `.claude/settings.json` hooks, `.vscode/tasks.json` and similar files,
  which tools run. A teammate's change to one of them now waits in the app as a notice ("Review
  change" opens the file's history, a button dismisses it) and is marked ⚠ in the activity log.
  Matching ignores letter case (`.CLAUDE/` is `.claude/` on APFS), and the list covers agent and
  editor settings (`.claude/`, `.codex/`, `.vscode/`, `.cursor/`, `.zed/`, `.idea/`,
  `.windsurf/`), `.husky/`, `.devcontainer/`, CI workflows, `package.json`, `.envrc`, `.npmrc`,
  `Makefile`, `justfile`, `CLAUDE.md`, `AGENTS.md`, `.mcp.json`, `pyproject.toml`, `setup.py`,
  `build.rs` and `*.command`. Exec bits are not synced, and synced files carry no quarantine
  flag. Only invite people you'd give push access to a repository, and use your agent's
  workspace-trust prompts.
- **The host is fully trusted.** It stores every file and version and could serve anything. It
  is a teammate's Mac or your own server.
- **Transport:** a hosting Mac serves HTTPS with a self-signed key pinned in every invite and in
  the install command (`curl --pinnedpubkey`). Only if `openssl` is missing (never the case on
  macOS) does it fall back to plain HTTP, where the `curl … | sh` installer could be tampered
  with on the LAN. The app now says so: "Hosting · not encrypted" on this Mac, and a "Not
  encrypted" badge on any project that syncs with a plain-HTTP server beyond this Mac.
- **Discovery** (Bonjour) advertises "Name (Mac name)" and the TLS key on the local network.
  `synchack --no-discover` (or `SYNCHACK_DISCOVER=0`) turns it off; teammates then join with the
  invite text.
- **Mass deletion:** the sending Mac pauses when 50 or more files (or half the project) are
  deleted at once (Oliver's guard). A modified client can skip that guard, so receiving Macs now
  move deleted files to `.synchack/trash/<date>/` for 7 days (SEC-15). The host keeps every
  version, and `synchack restore` recovers them.
- **Dependencies:** `npm audit` reports 0 vulnerabilities (runtime: `ws`, `ink`, `react`).
- **Local web UI:** it binds `127.0.0.1`, uses a random token per launch, checks the `Host`
  header (DNS rebinding) and sends a CSP. Every remote string is HTML-escaped. There are no
  desktop notifications and no Electron.
- **Look-alike file names** (Unicode homoglyphs such as Cyrillic `а`) are distinct files and are
  not flagged.

## Verified (tests that already passed)

- **Cross-project isolation (SEC-08):** a member of project A gets 401 on all 13 project routes
  of project B, and its WebSocket upgrade is refused.
- **Traversal on the server and the client:**
  - the server refuses `../`, `/abs`, `a/../../b`, oversized paths, malformed hashes, negative
    versions and blobs that were never uploaded (SEC-09);
  - the client refuses hostile pushed paths (`sync.test.ts`, "duplicate, stale and hostile events").
- **No writes through symlinks (SEC-11):** a symlinked file or folder in the project is never
  written through.
- **Replays and duplicates:** duplicate and out-of-order events are ignored (version checks).
  Votes are one per device. Resolving twice returns 409. Conflict candidates are immutable.
- **Accounts and requests:**
  - rejoining requires the device's current token (no identity takeover);
  - removed members lose their token and socket, and the invite is replaced;
  - JSON routes require a JSON content type (no cross-site form posts);
  - client WebSocket messages are capped at 4 KB.
- **Implementation:** all SQL is parameterized, and every child process (`open`, `tar`,
  `openssl`, `dns-sd`, `pbcopy`) runs from an argument array, never through a shell.

## Deployment requirements

1. **Never expose a server beyond the LAN without TLS.** Set `TLS_CERT` and `TLS_KEY`, or
   terminate TLS at a proxy. Clients and installers then use `https://` and `wss://`.
2. Behind a proxy, keep the standalone defaults (loopback is rate-limited). Add per-client
   limits at the proxy if it hides client addresses.
3. Keep `DATA_DIR` private (0700) and back it up (`node server/backup.ts`). Set
   `SYNCHACK_QUOTA_GB` to fit the disk; blobs are never deleted.
4. Treat membership like push access. Remove people you no longer work with (`synchack remove`);
   that also replaces the invite.

## Running the security tests

```sh
node --test --test-concurrency=1 test/security.test.ts   # 25 attack scenarios
npm test                                                  # everything (73 tests)
```
