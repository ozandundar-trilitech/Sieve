# Sieve Desktop — implementation plan

Status: Phases 0–3 implemented and tested, 2026-10-13. Branch: `desktop-app`.
Nothing here is merged to `main`. See §10 for what was built, what changed from
this plan, and how to run it.

## 1. Goal

Let a non-technical person use Gmail and Slack through Claude, governed by Sieve,
without a terminal, Docker, Go, a cloud console, or remembering a port number.

Target first-run experience on macOS:

1. Download `Sieve.dmg`, drag to Applications, open. No Gatekeeper warning.
2. A tray icon appears. The Sieve window opens on the first-run page.
3. Set an admin password. Click **Connect Google Account**, sign in. Done.
4. Click **Connect to Claude Desktop**. Pick a preset (read-only / drafter / full
   with approval). Claude Desktop restarts and has the tools.
5. When an agent needs approval, a macOS notification with **Approve** / **Reject**
   appears. When a connection needs re-auth, a notification says so.

Everything about tokens, roles, rules, approvals, and audit stays in the existing
admin UI. The desktop app is a shell around the Go server, not a second UI.

## 2. Non-goals (v1)

- Hosted / multi-tenant Sieve. The server still runs on the user's machine and
  credentials never leave it.
- Replacing the admin UI with native screens.
- claude.ai (web) support. That needs MCP OAuth on the agent port and a publicly
  reachable server; separate project.
- Linux packaging. The Go binary already covers Linux; a desktop shell can follow.
- Homebrew tap. Parked; see the conversation log. Nothing here blocks it.

## 3. Architecture

```
┌──────────────────────── Sieve.app (Electron) ────────────────────────┐
│  main process                                                        │
│   ├─ sidecar supervisor ──spawn──▶ bundled `sieve` binary (Go)       │
│   │     passphrase over fd 3        ├─ 127.0.0.1:19816 admin UI (TLS)│
│   │     restart w/ backoff          └─ 127.0.0.1:19817 API + MCP     │
│   ├─ tray menu  (Open Sieve · Approvals (n) · Quit)                  │
│   ├─ BrowserWindow ──loads──▶ https://127.0.0.1:19816  (cert pinned) │
│   ├─ event client ──SSE──▶ /events  → native notifications           │
│   └─ "Connect to Claude" ──writes──▶ Keychain + claude_desktop_config │
│  preload: contextBridge exposes a tiny `window.sieveDesktop` API     │
└──────────────────────────────────────────────────────────────────────┘
```

Decisions, and why:

- **Electron, not Tauri.** Team is JavaScript-first; electron-builder has the most
  mature signing, notarization, and auto-update path on both macOS and Windows.
  The 150 MB download is accepted. Tauri remains a drop-in alternative because
  the shell has almost no frontend code of its own.
- **Native Go sidecar, not Docker.** Docker Desktop is the step we are removing.
  The binary is one static file; the app spawns it with the same fixed ports
  the project already documents, bound to loopback only.
- **Same repo, `desktop/` directory, on this branch.** The sidecar is built from
  the same checkout (`go build ./cmd/sieve`), so one tag produces one matching
  app + server pair. Splitting into `sieve-desktop` later is a directory move.
- **The admin UI stays HTTPS.** Slack OAuth requires an HTTPS redirect, so we
  cannot fall back to plaintext under the shell. The app trusts exactly the cert
  the server wrote to `<data>/tls/admin-cert.pem` and nothing else.

## 4. Security invariants (carry through every phase)

1. **Two-port split is preserved.** The shell talks only to 19816 with an
   operator session. It never holds, stores, or forwards an agent token except
   for the one-time hand-off into Keychain during "Connect to Claude".
2. **No env-var secrets.** Passphrase goes in over `SIEVE_PASSPHRASE_FD=3`
   (already supported, opt-in by name). The passphrase itself lives in
   Electron `safeStorage` (Keychain-backed on macOS, DPAPI on Windows).
3. **New admin endpoints sit behind `requireOperatorSession`** and are rejected
   for agent bearer tokens like every other admin route. `/events` is not added
   to `authExemptPaths`.
4. **Notification payloads are redacted.** Reuse `audit.RedactSensitive`; never
   include message bodies, recipients beyond a count, or credentials. A
   notification can be visible on a locked screen.
5. **The preload bridge is allow-listed.** `contextIsolation: true`,
   `nodeIntegration: false`, `sandbox: true`. The bridge exposes named functions
   only; the page never gets `require`.
6. **First-run bootstrap stays loopback-only.** `/setup` already enforces this;
   the app window is a loopback client so it works unchanged.

## 5. Go-side changes (branch `desktop-app`, each a separate PR to `main` once proven)

### 5.1 Pure-Go SQLite (prerequisite for cross-compiling)

Replace `github.com/mattn/go-sqlite3` with `modernc.org/sqlite`. Same
`database/sql` surface; driver name changes from `sqlite3` to `sqlite`, and the
`isUniqueViolation` check in `internal/iampolicies` must switch from the
`sqlite3.Error` type assertion to the modernc equivalent. Run `go test ./... -race`.
Without this, macOS arm64 + amd64 + Windows builds each need a native runner.

### 5.2 Event stream for notifications

New package `internal/events`: an in-process hub with `Publish(Event)` and
`Subscribe(ctx) <-chan Event`, bounded buffers, drop-oldest on slow consumers.

Event types and where they are published:

| Type | Published from | Payload |
|---|---|---|
| `approval.pending` | `approval.Queue.Submit` | approval id, token name, connection id, operation, redacted param summary |
| `approval.resolved` | `approval.Queue.resolve` | approval id, status (lets the app dismiss a stale notification) |
| `connection.reauth_required` | `connections.Service.SetStatusWithReason` when status becomes `reauth_required` | connection id, display name, reason, reauth URL |
| `policy.denied` | the API/MCP PEPs where `logAudit(..., "deny", ...)` is called | token name, connection id, operation, reason |

Endpoint: `GET /events` on the admin server, `text/event-stream`, behind the
operator session. Sends a `hello` event first carrying the session's CSRF token
so the client can POST approve/reject without scraping HTML. Heartbeat comment
every 15 s. Server-side throttle on `policy.denied`: at most one per
(token, connection, operation) per 60 s, with a `count` field.

### 5.3 Small admin conveniences

- `GET /approvals/pending.json` (session-gated): the pending list, for the tray
  badge on startup and after reconnect.
- The tokens page detects `window.sieveDesktop` and, when present, shows a
  **Connect to Claude Desktop** button next to the one-time token display. The
  page calls `window.sieveDesktop.connectClaude({ token, name })`. Without the
  bridge the page is unchanged.
- `sieve mcp-launch`: add a Windows Credential Manager branch beside the macOS
  Keychain one (Phase 5).

### 5.4 Build-time OAuth client IDs

Inject `defaultGoogleClientID` via `-ldflags` in the sidecar build (plumbing
exists in `internal/web/server.go`). Add the equivalent for Slack if not already
present on this branch. These are public-client IDs; PKCE provides the proof.

## 6. Desktop app (`desktop/`)

Stack: Electron, TypeScript, electron-builder, electron-updater. No UI framework;
the only HTML the app owns is a tiny "starting / crashed" placeholder.

### 6.1 Sidecar supervisor (`desktop/src/sidecar.ts`)

- Locate the binary: `process.resourcesPath + '/bin/sieve'` in production,
  `../sieve` (built by `go build`) in development.
- Data dir: `app.getPath('userData') + '/data'`; pass `--db <dir>/sieve.db`.
  The server derives `tls/` from the db dir, so the cert lands beside it.
- Spawn with `['--web','127.0.0.1:19816','--api','127.0.0.1:19817','--db',...]`,
  `env: { SIEVE_PASSPHRASE_FD: '3' }`, `stdio: ['ignore','pipe','pipe','pipe']`;
  write the passphrase + newline to fd 3, then close it.
- First run: generate a 32-byte random passphrase, store via `safeStorage`,
  spawn with `--setup`. Subsequent runs: decrypt and spawn normally.
- Readiness: poll `https://127.0.0.1:19816/login` until 200 (with the pinned
  cert), max 15 s, then open the window.
- Crash: restart with exponential backoff (1 s → 30 s), notification after the
  second failure, placeholder page in the window.
- Port conflict: if bind fails with EADDRINUSE and no sidecar is ours, show
  "Sieve is already running" and exit. `app.requestSingleInstanceLock()` covers
  the double-launch case.
- Quit: SIGTERM, wait 5 s, SIGKILL.

### 6.2 Window + cert pinning (`desktop/src/window.ts`)

- `BrowserWindow` loading `https://127.0.0.1:19816/`. Persistent session
  partition so the operator cookie survives restarts until it idles out.
- `app.on('certificate-error')`: allow only if the presented cert's fingerprint
  equals the SHA-256 of `<data>/tls/admin-cert.pem`. Everything else is denied.
- External links (`target=_blank`, OAuth consent pages that leave loopback):
  open in the system browser via `shell.openExternal`. OAuth callbacks come back
  to `https://127.0.0.1:19816/oauth/callback`, which the server already handles;
  the window reloads on focus so the new connection shows.
- Hidden-on-close, not quit; the tray keeps the app alive.

### 6.3 Tray (`desktop/src/tray.ts`)

Menu: **Open Sieve**, **Approvals (n)**, separator, **Start at login** (toggle,
`app.setLoginItemSettings`), **Quit**. Badge count comes from
`/approvals/pending.json` on start and from `approval.*` events after.

### 6.4 Notifications (`desktop/src/events.ts`)

- Connect to `/events` with `net.fetch` on the window's session so the operator
  cookie is sent. Reconnect with backoff; re-fetch pending on reconnect.
- `approval.pending` → `Notification` with actions **Approve** / **Reject**
  (macOS supports actions; Windows shows the body and click-to-open). Action
  handlers POST `/approvals/{id}/approve|reject` with the CSRF token from the
  `hello` event. Clicking the body opens the window on `/approvals`.
- `approval.resolved` → close the matching notification if still shown.
- `connection.reauth_required` → notification; click opens the reauth URL in
  the window.
- `policy.denied` → notification, respecting the server throttle; user can mute
  this class in the tray menu (stored in `electron-store`).

### 6.5 Connect to Claude (`desktop/src/claude.ts`)

Triggered by the preload bridge from the tokens page with the one-time token.

- macOS: `security add-generic-password -U -a $USER -s sieve-token -w <token>`
  (the `-U` updates an existing entry), then merge into
  `~/Library/Application Support/Claude/claude_desktop_config.json`:
  `{"mcpServers":{"sieve":{"command":"<resourcesPath>/bin/sieve","args":["mcp-launch"]}}}`.
  Use the absolute bundled path; Claude Desktop's PATH is minimal.
- Offer to relaunch Claude Desktop (`osascript -e 'quit app "Claude"'`, then
  `open -a Claude`); it only reads the config at launch.
- Claude Code: show a copyable `.mcp.json` snippet instead of writing files.
- The token is held in memory only for the duration of the call.

### 6.6 Preload (`desktop/src/preload.ts`)

`contextBridge.exposeInMainWorld('sieveDesktop', { connectClaude, version })`.
Nothing else. The page feature-detects it.

## 7. Packaging, signing, updates (`desktop/electron-builder.yml`)

- `extraResources: [{ from: ../dist/sieve-${os}-${arch}, to: bin/sieve }]`.
  A `make sidecar` target cross-compiles the Go binary per target with ldflags.
- macOS: Developer ID Application certificate, hardened runtime, entitlements
  file, notarization via electron-builder's `notarize` option (App Store Connect
  API key in CI secrets). **The sidecar binary must be signed too**; electron-
  builder signs everything under `Contents/` when `signIgnore` is left default.
  Output: `.dmg` + `.zip` (the zip is what electron-updater uses).
- Windows: NSIS installer, Authenticode via Azure Trusted Signing. Output `.exe`.
- Auto-update: electron-updater against GitHub Releases on this repo. The app
  version and the sidecar version are the same tag.
- CI: GitHub Actions workflow on tag `desktop-v*`: build sidecars (Linux
  runner, pure-Go), build + sign mac app (macOS runner), build + sign Windows
  app (Windows runner), attach to the release.

## 8. Phases and acceptance

| Phase | Scope | Done when | Status |
|---|---|---|---|
| 0 | Go: pure-Go SQLite; `internal/events`; `/events`; `/approvals/pending.json` | `go test ./... -race` green; `curl -N` on `/events` with a session cookie shows an approval event when one is submitted via the API | Done |
| 1 | Electron skeleton: sidecar supervisor, passphrase in safeStorage, window with cert pinning, tray, single instance | Fresh machine: open app → `/setup` → connect a mock connection → quit → reopen → still logged in, data intact | Done; re-login after relaunch (§10.2.3) |
| 2 | Notifications | Submit an approval via the REST API with a blocking client; the notification's Approve button unblocks it | Done |
| 3 | Connect to Claude | Mint a token in the UI → one click → Claude Desktop lists Sieve tools after relaunch | Done on macOS |
| 4 | macOS signing, notarization, DMG, auto-update | A colleague on a different Mac opens the DMG with no warning; a second tagged build auto-updates | Blocked: Apple Developer enrollment |
| 5 | Windows: Credential Manager branch in `mcp-launch`, NSIS, Authenticode | Same acceptance as 3 and 4 on Windows 11 | Not started |

Phases 0 and 1 can proceed in parallel: the app can be built against a
hand-built sidecar from `main` until the event stream lands.

## 9. Open questions

1. **Apple Developer Program enrollment** under Trilitech. Slowest external
   dependency (D-U-N-S verification); start now. Until then, Phase 4 can only
   produce ad-hoc builds that need "Open Anyway".
2. **Windows signing**: Azure Trusted Signing vs an OV certificate. Trusted
   Signing avoids the SmartScreen reputation warm-up.
3. **Shipped OAuth client IDs**: who owns the Google Cloud project and the Slack
   app that the public-client IDs come from, and whether the Google consent
   screen is Internal (org-only) or External (needs verification for Gmail
   scopes). Blocks the "no cloud console" promise for users outside Trilitech.
4. **Operator password vs no password**: should the shell auto-create the
   operator credential and skip the login screen, treating the OS login as
   the gate? Simpler for users; weaker if the machine is shared. Default:
   keep the password, pre-fill nothing.
5. **Re-login friction**: the window is logged out on every app restart (the
   session cookie has no expiry) and after the idle timeout. Notifications
   pause until the operator logs back in (they are caught up then). Options:
   a persistent cookie for loopback sessions, or the shell storing the
   operator credential in the Keychain and logging in itself. Both weaken
   "the admin password is the gate" on a shared machine. Undecided.
6. **Where `policy.denied` is published**: both PEPs call `logAudit` with
   `"deny"` in several places. Publishing from inside the audit logger keeps
   it to one site but couples the logger to the hub. Lean: publish from the
   logger behind a `Notifier` interface, nil in tests.

## 10. Implementation notes (2026-10-13)

### 10.1 What exists

**Go (`desktop-app` branch):**

- `modernc.org/sqlite` replaces `mattn/go-sqlite3`; `CGO_ENABLED=0` builds
  macOS arm64/amd64, Windows, and Linux from one machine. Pinned to v1.59.0
  because v1.60 requires Go 1.26 and the Dockerfile builds with Go 1.25.
  Pragmas now go in the DSN, so foreign keys / WAL / busy timeout apply to
  every pooled connection (previously only the first). `_time_format=sqlite`
  keeps the timestamp layout the CGO driver wrote. Tests:
  `internal/database/dsn_test.go`.
- `internal/events`: non-blocking hub (drop-oldest per subscriber, nil-safe)
  plus a `Throttle`. Publishers: `approval.Queue` (pending/resolved; param
  NAMES only), `connections.Service` (transition into `reauth_required` only,
  not repeats), `audit.Logger` (agent `deny` rows, one per token×connection×op
  per 60 s with a count).
- Admin endpoints, both behind the operator session: `GET /events` (SSE,
  `hello` carries the CSRF token, 15 s heartbeat that re-checks the session
  WITHOUT sliding it, `session_ended` then close; hub closes on shutdown) and
  `GET /approvals/pending.json`. New `session.Manager.Valid` (non-sliding check).
- `sieve --init-if-needed` (new). **Deviation from §6.1:** `--setup` is
  TTY-only by design (a file/fd source must never satisfy its confirmation
  prompt), so the app cannot use it. The new flag requires
  `SIEVE_PASSPHRASE_FD` or `SIEVE_PASSPHRASE_FILE`, initializes the keyring
  only when the DB has none, and otherwise loads; a wrong passphrase on an
  existing DB still fails. `--setup` is unchanged.
- Tokens page: a "Connect to Claude Desktop" button, hidden unless
  `window.sieveDesktop.connectClaude` exists (browser UI unchanged).

**Electron (`desktop/`):** `config.ts`, `passphrase.ts` (safeStorage-sealed
random key; refuses to mint a new key when data already exists), `certs.ts`,
`sidecar.ts`, `window.ts`, `tray.ts`, `events.ts`, `notifier.ts`,
`claude.ts`, `prefs.ts`, `preload.ts`, `static/status.html`.

### 10.2 Decisions and findings that changed the plan

1. **OAuth runs in the app window, not the system browser.** The server binds
   each pending OAuth flow to the operator session that started it
   (`operatorSessionHash`), and the system browser has no session, so a
   system-browser callback is rejected. The window therefore navigates to the
   provider consent hosts (same allowlist as the CSP `form-action`). Because
   Google blocks sign-in from user agents that identify as Electron, the
   admin partition sends the plain Chrome UA. This works but is against the
   spirit of Google's embedded-browser policy; the durable fix is a
   system-browser flow with a one-time handoff code that rebinds the callback
   to the app's session. **Not yet tested against real Google/Slack.**
2. **Cert pinning by fingerprint, not `ca`.** The server's cert is a `CA:FALSE`
   leaf; Electron's BoringSSL (unlike Node's OpenSSL) refuses it as its own
   trust anchor. Both the window (`setCertificateVerifyProc`) and the
   readiness probe compare the presented cert's SHA-256 to the file.
3. **Re-login after every app launch.** The operator session cookie has no
   expiry, so it ends with the app. Phase 1's "still logged in after reopen"
   acceptance was changed to "same key unlocks the same data; operator logs in
   again". Open question 5 below now covers both idle timeout and restart.
4. **`session.fetch` throws on redirects in `manual` mode.** The event client
   follows redirects and treats landing on `/login` (HTML) as "needs login";
   approve/reject require the final URL to be `/approvals`.
5. **Missed approvals are caught up.** On every (re)connect the client lists
   pending approvals and notifies any it has not shown, once. Covers app start
   while an agent is already waiting.
6. **Logout drops the stream immediately** when the window shows `/login`,
   rather than at the server's next 15 s session check.
7. **Token to Keychain via `security -i` over stdin**, so it never appears in
   a process argument list. Claude config is merged (other servers and keys
   preserved), backed up to `*.before-sieve`, written atomically, and left
   untouched if it is not valid JSON. The entry runs the bundled binary by
   absolute path with `--keychain sieve-claude-desktop --url …/mcp`.

### 10.3 How to run and test

```bash
# Server binary for the app (needs Go; CGO off)
cd desktop && npm install && npm run build:sidecar
npm start                 # build TypeScript and launch the app
npx playwright test       # 14 end-to-end tests: real Electron + real Go server
```

Test isolation: each spec uses its own `userData` dir and ports (398x6/398x7),
so a running Sieve on 19816/19817 is untouched. The Claude spec uses a
throwaway keychain file and a temp Claude config and restores the keychain
search list. Test-only hooks (`SIEVE_DESKTOP_TEST_HOOKS`, path overrides) are
ignored in packaged builds.

### 10.4 Not verified

- ~~Native notification rendering and action buttons on a real desktop.~~
  Verified by hand on macOS (2026-10-13) with the installed, ad-hoc-signed
  app: the notification appears, a click on its body opens /approvals, and
  the Approve button (Alerts style) unblocks the waiting agent within the
  same second. Finding: when two copies of the app with the same bundle ID
  run at once (e.g. an installed copy plus a preview), macOS delivers
  notification clicks to the other copy, so they appear to do nothing.
  Previews should use their own appId. The app logs notification
  shown/failed/clicked/action to `logs/desktop.log`.
- Real Google / Slack OAuth inside the window (see 10.2.1).
- Windows. `claude.ts` refuses on non-macOS; `mcp-launch` has no Credential
  Manager branch yet (Phase 5).
- Pre-existing, unrelated test failures on this Mac:
  `internal/policy` `TestApplyResponseFilters_ScriptTransformRewriteApplied`
  (macOS `/bin/sh` printf escaping) and `internal/secrets` (a test closes
  fd 3, which `go test` uses for its log). Both fail identically on `main`.
