# Mcode Agent Runtime Contract

This document is the authoritative reference for operating this repo as an autonomous agent.
Read it before starting any work. Run `bun run doctor` to verify your environment.

---

## Startup Commands

| Command | What it starts |
|---------|---------------|
| `bun run --shell system agent:up` | Worktree-local agent runtime under `.dev/`, with startup JSON printed to stdout |
| `bun run --shell system agent:down` | Stops only PIDs recorded under `.dev/pids/` |
| `bun run --shell system agent:reset` | Stops the runtime, deletes `.dev/db`, then starts a fresh seeded runtime |
| `bun run dev:web` | Vite frontend + bundled backend under Electron's Node (no Electron window) |
| `bun run dev:desktop` | Full Electron desktop app |
| `bun run dev:server` | Backend server only (no frontend): `bun src/index.ts` |

For agent-driven work, prefer `bun run --shell system agent:up`. It creates
`.dev/`, starts the server and web app with per-worktree ports and database
paths, writes `.dev/ports.json`, and prints that JSON as the final line after
`/health` returns 200. Consumers should read `ports.json`; do not recompute
ports. On Windows, plain `bun run agent:up` still starts the runtime, but Bun
Shell can drop the final stdout line.

Use `bun run dev:web` only when the task needs the live web runtime. It builds
the server bundle and runs it with Electron's Node.js. It also starts Vite.

Use `bun run dev:desktop` only when testing Electron-specific behavior (native IPC,
tray, window management).

---

## Verification Commands

```sh
bun run test        # Vitest unit tests (apps/web, apps/desktop)
bun run typecheck   # tsc --noEmit across all packages
bun run lint        # ESLint
bun run doctor      # Verify all prerequisites (run this first)
```

After cross-package changes (function signatures, shared interfaces), typecheck all packages:

```sh
(cd apps/server && bun x tsc --noEmit)
(cd apps/web && bun x tsc --noEmit)
(cd apps/desktop && bun x tsc --noEmit)
```

---

## Required Tools

| Tool | Default | Install |
|------|---------|---------|
| `bun` | Package manager, repository script runner, and test runtime | https://bun.sh |
| `git` | Version control | https://git-scm.com |

Electron is installed by `bun install` and bundles the Node.js runtime used by
the backend and native modules. Chromium is bundled by Electron and renders the
web frontend. No system Node.js executable or version manager is required.

CI desktop packaging is the only exception. The packaging jobs provision Node
24.18.0 with `actions/setup-node` before running
`bun apps/desktop/scripts/desktop-packaging/target-package/ci-package.mjs`. Bun remains the workflow orchestrator;
the helper uses the provisioned Node executable for npm, electron-builder, and
native-module rebuild compatibility. Local development and agent workflows need
only Bun.

`better-sqlite3` has one repository-managed native binding:
`build/Release/better_sqlite3.electron.node`. Postinstall downloads and verifies
that Electron-compatible binding when Electron is installed. Bun never loads
the database binding; `dev:web`, `agent:up`, and desktop startup launch the
backend with Electron's Node.js (`ELECTRON_RUN_AS_NODE=1`).

---

## Environment Variables

All variables are optional — defaults work for local development.

| Variable | Default (dev) | Description |
|----------|---------------|-------------|
| `MCODE_DATA_DIR` | `~/.mcode-dev` | Root data directory (`~/.mcode` in prod) |
| `MCODE_DB_PATH` | `$MCODE_DATA_DIR/mcode.db` | SQLite database path override |
| `MCODE_DRIZZLE_MIGRATIONS_DIR` | (unset) | Absolute path to `apps/server/drizzle`; Vitest sets this automatically |
| `MCODE_GIT_BRANCH` | (unset) | Current checkout branch for dev-only hashed DB files (`dbs/dev-*.db`) when not using a linked worktree |
| `MCODE_GIT_TOPLEVEL` | (unset) | `git rev-parse --show-toplevel`; with a linked worktree, enables `<toplevel>/.mcode-local/mcode.db` |
| `MCODE_PORT` | `19400` | HTTP/WS server port (increments on collision, up to 19409) |
| `MCODE_HOST` | `127.0.0.1` | Server bind host |
| `MCODE_AUTH_TOKEN` | `""` (empty) | Empty string bypasses auth in dev |
| `MCODE_SINGLE_INSTANCE` | `true` in dev, `false` in test/prod | Requires a paired dev UI to present this worktree's instance token and identity |
| `MCODE_INSTANCE_TOKEN` | (unset) | Random per-runtime token used only for dev UI pairing |
| `MCODE_WORKTREE_IDENTITY` | (unset) | Worktree identity the UI must present when single-instance mode is on |
| `MCODE_VERSION` | `0.0.1` | Reported version string |
| `MCODE_CLAUDE_PATH` | `claude` | Path to the Claude CLI binary |
| `MCODE_GIT_PATH` | `git` | Path to the git binary |
| `SNAPSHOT_MAX_AGE_DAYS` | `30` | Days before turn snapshot cleanup |
| `SKIP_ELECTRON_REBUILD` | (unset) | Set to `1` to skip Electron ABI download in postinstall |
| `NODE_ENV` | `development` | Controls data dir suffix and log verbosity |
| `MCODE_CODEX_TRACE` | (unset) | Set to `1` to log each Codex JSON-RPC notification and mapped `AgentEvent` summaries (for debugging sub-agent and narrative issues) |

Copy `.env.example` to `.env` and uncomment to override any variable.

### Child process environment

PTY sessions, provider CLI subprocesses, and other server-spawned children receive environment built by **`EnvService`** (`apps/server/src/runtime/environment/env-service.ts`). It merges, in order:

1. The current server `process.env` (keeps volatile vars such as `TEMP` on Windows)
2. A refresh from the user's login shell (`env -0` on Unix) or from the Windows user and machine registry (cached about 60 seconds)
3. **`ProtectedEnvStore`**, which forces keys captured at server startup whose names start with `MCODE_`, `ELECTRON_`, or `BETTER_SQLITE3_`, plus any key registered via `protect()`

The server does not periodically mutate its own `process.env`. The Claude Agent SDK subprocess reads `process.env` at session start only; the provider updates `process.env` once immediately before each `sdkQuery()` call so that path stays aligned.

---

## Runtime Artifact Locations

Use `bun run state:paths` to print all resolved paths for the current environment.

| Artifact | Path |
|----------|------|
| Repo root | `<cwd>` |
| Worktrees | `.worktrees/` (relative to repo root) |
| Data directory | `MCODE_DATA_DIR` (see above) |
| Database | `MCODE_DB_PATH`, or `<toplevel>/.mcode-local/mcode.db` in a dev linked worktree, else dev `dbs/dev-*.db`, else default under data dir (see env table) |
| Log files | `$MCODE_DATA_DIR/logs/mcode.log.YYYY-MM-DD` |
| Disposable verification | `.dev/verification/` |

Log files rotate daily and are retained for 14 days.

### Agent runtime artifacts

`bun run --shell system agent:up` owns only the current worktree's `.dev/`
directory.

| Artifact | Path |
|----------|------|
| Runtime contract | `.dev/ports.json` |
| Database | `.dev/db/app.sqlite` |
| Fixture repo | `.dev/fixture-repo/` |
| Logs | `.dev/logs/` |
| PID files | `.dev/pids/` |
| External Playwright scratch area | `.dev/playwright-scratch/` |
| Electron user data | `.dev/electron/` |

`ports.json` contains `{ instanceToken, worktreeIdentity, serverPort, webPort,
healthUrl, appUrl, seedLogin, logsDir }`. `seedLogin.email` is
`agent@seed.local`; Mcode uses token auth, so agents authenticate with
`seedLogin.authHeader` or the `mcode-auth` cookie. Treat `instanceToken` and
`seedLogin.token` as secrets.

In single-instance dev mode, browser discovery reads only this worktree's
`.dev/ports.json` through the dev entry point. It does not scan localhost or
recover a token from `/health`. A wrong-instance WebSocket attach is refused
with `WRONG_INSTANCE`, `expectedWorktree`, and `presentedWorktree`; token values
are not included.

The fixture repo has `main`, `feature/agent-runtime`, and
`conflict/agent-runtime`. Merging the conflict branch into `main` creates a real
conflict for handoff and conflict-flow testing.

### Cursor provider tracing

Set `provider.cursor.traceSessionUpdates` to `true` in `settings.json`, restart so the backend reloads settings, reproduce a Cursor thread, then grep `mcode.log.*` under `$MCODE_DATA_DIR/logs/` for `Cursor ACP session/update trace`. Each structured line lists the sanitized inbound `notification` envelope plus summarized `mappedEvents` so you can decide whether Cursor is omitting `kind`/`rawInput`, mis-sizing sub-agent parents, etc. Streaming assistant chunks (`sessionUpdate: "agent_message_chunk"`) stay off the trace on purpose because they overwhelm the logs.

Upstream references:

- [Cursor CLI ACP docs](https://cursor.com/docs/cli/acp)
- [Agent Client Protocol tool calls](https://agentclientprotocol.com/protocol/tool-calls)

Capture live ACP envelopes for mapper work:

```sh
bun apps/server/scripts/capture-cursor-acp.ts --suite
```

Artifacts land in `<repo>/.mcode-local/cursor-acp-capture/` (`*-raw.jsonl`, `*-mapped.jsonl`, `*-summary.txt`). Golden tool-only traces live in `apps/server/src/providers/cursor/__tests__/fixtures/`.

---

## Server Discovery

The backend server is an HTTP + WebSocket server.

- **Default URL:** `http://127.0.0.1:19400`
- **Port range:** 19400–19409 (10 attempts; actual port printed to stdout on startup)
- **Health check:** `GET /health` → `{ "status": "ok", "activeAgents": <number> }`
- **WebSocket:** `ws://localhost:<port>`
- **Auth:** In dev, `MCODE_AUTH_TOKEN=""` bypasses authentication entirely.

When `MCODE_SINGLE_INSTANCE=true`, `/health` remains unauthenticated but does
not return `authToken` and does not set `mcode-auth`. Set
`MCODE_SINGLE_INSTANCE=false` to keep the shared-server discovery behavior where
`/health` can return the current token for localhost reconnects.

---

## Debug Scripts

| Script | What it does |
|--------|-------------|
| `bun run state:paths` | Print resolved data dir, DB path, and log directory |
| `bun run logs:tail` | Stream and follow today's log file (Ctrl+C to exit) |
| `bun run state:reset` | Wipe `MCODE_DATA_DIR` safely (dev-only, prompts for confirmation) |
| `bun run db:info` | Print DB path, schema version, and row counts for key tables |
| `bun run --shell system agent:up` | Start the worktree-local agent runtime and print `.dev/ports.json` |
| `bun run --shell system agent:down` | Stop only PIDs recorded in `.dev/pids/` |
| `bun run --shell system agent:reset` | Stop, delete `.dev/db`, remigrate, reseed, and restart |

---

## Agent Write Boundaries

**Allowed write areas:**
- Repo working tree (any file not blocked by the `.env` hook in `.claude/settings.json`)
- `.worktrees/` directory
- `MCODE_DATA_DIR` and its contents

**Restricted (do not touch unless explicitly asked):**
- `.env` files — update `.env.example` instead; a PreToolUse hook blocks direct `.env` edits
- Home directory outside of `MCODE_DATA_DIR`

---

## Safe Reset Procedure

To wipe all local app state (database, logs, thread history):

```sh
bun run state:reset
```

This is dev-only and prompts for confirmation. It deletes `MCODE_DATA_DIR` and re-creates
it as an empty directory. The app recreates the database with all migrations applied on
next startup.

---

## Test Process Isolation

`vitest` is configured in every package's `vitest.config.ts` to set
`MCODE_DATA_DIR` to a unique `os.tmpdir()` subdirectory per run. This
prevents test-time writes from colliding with a live `bun run dev`
server that is writing to the same `~/.mcode` or `~/.mcode-dev`
directory. Never remove that env injection.

---

## Unclean-Shutdown Breadcrumb

The server writes a `.clean-shutdown` marker file under the data dir at
the end of its graceful `shutdown()` path. On startup it deletes the
marker if present; if the marker is missing, it logs a warning. A
missing marker at startup means the previous process died without
running `shutdown()`, which is the primary diagnostic signal for
issue #290-class restarts.

---

## Common Workflows

Slash commands are first-class in Claude Code. Other harnesses (Cursor, Codex, OpenCode) run the underlying script directly.

| Workflow | Claude command | Equivalent shell |
|----------|----------------|------------------|
| Typecheck + lint + unit tests | `/verify` | `bun run verify` |
| Start web runtime | Shared agent guidance | `bun run dev:web` |
| Launch desktop runtime | Shared agent guidance | `bun run dev:desktop` |

## Live verification

Use live verification only when the agent workflow or the user requests it. For
UI or Electron-only behavior, load `$electorn-live-testing`. Put temporary
scripts, fixtures, screenshots, annotations, and logs under `.dev/verification/`.

---

## Bootstrap from Scratch

```sh
git clone <repo>
cd mcode
bun run setup       # Copy .env.example → .env, configure git hooks
bun install         # Install dependencies (also builds Electron ABI binding)
bun run doctor      # Verify all prerequisites pass
bun run --shell system agent:up  # Start isolated agent runtime
# or
bun run dev:web     # Start web development server
```
