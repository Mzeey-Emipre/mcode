# Mcode Agent Runtime Contract

This document is the authoritative reference for operating this repo as an autonomous agent.
Read it before starting any work. Run `bun run doctor` to verify your environment.

---

## Startup Commands

| Command | What it starts |
|---------|---------------|
| `bun run dev:web` | Vite frontend + backend server (web-only, no Electron needed) |
| `bun run dev:desktop` | Full Electron desktop app |
| `bun run dev:server` | Backend server only (no frontend) |

**For most development work, use `bun run dev:web`.** It starts the server under
Electron's Node.js (required for the `better-sqlite3` native module ABI) and Vite
together. No Electron binary is needed.

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
| `bun` | Package manager + runtime | https://bun.sh |
| `git` | Version control | https://git-scm.com |
| `node` | Script execution | https://nodejs.org |
| Playwright | E2E tests | `cd apps/web && bun x playwright install` |

> **Note:** Electron bundles its own Node.js binary for the renderer/server process.
> The system `node` is only needed for running scripts at the repo root.

> **Note:** `better-sqlite3` has two native bindings: one compiled for the system
> Node ABI (used by root scripts) and one compiled for Electron's ABI (used by the
> running server). Both are installed by `bun install` + `node scripts/postinstall.mjs`.

---

## Environment Variables

All variables are optional — defaults work for local development.

| Variable | Default (dev) | Description |
|----------|---------------|-------------|
| `MCODE_DATA_DIR` | `~/.mcode-dev` | Root data directory (`~/.mcode` in prod) |
| `MCODE_DB_PATH` | `$MCODE_DATA_DIR/mcode.db` | SQLite database path override |
| `MCODE_PORT` | `19400` | HTTP/WS server port (increments on collision, up to 19409) |
| `MCODE_HOST` | `127.0.0.1` | Server bind host |
| `MCODE_AUTH_TOKEN` | `""` (empty) | Empty string bypasses auth in dev |
| `MCODE_VERSION` | `0.0.1` | Reported version string |
| `MCODE_CLAUDE_PATH` | `claude` | Path to the Claude CLI binary |
| `MCODE_GIT_PATH` | `git` | Path to the git binary |
| `SNAPSHOT_MAX_AGE_DAYS` | `30` | Days before turn snapshot cleanup |
| `SKIP_ELECTRON_REBUILD` | (unset) | Set to `1` to skip Electron ABI rebuild in postinstall |
| `NODE_ENV` | `development` | Controls data dir suffix and log verbosity |

Copy `.env.example` to `.env` and uncomment to override any variable.

---

## Runtime Artifact Locations

Use `bun run state:paths` to print all resolved paths for the current environment.

| Artifact | Path |
|----------|------|
| Repo root | `<cwd>` |
| Worktrees | `.worktrees/` (relative to repo root) |
| Data directory | `MCODE_DATA_DIR` (see above) |
| Database | `MCODE_DB_PATH` (see above) |
| Log files | `$MCODE_DATA_DIR/logs/mcode.log.YYYY-MM-DD` |
| Playwright screenshots | `apps/web/e2e/screenshots/` |

Log files rotate daily and are retained for 14 days.

---

## Server Discovery

The backend server is an HTTP + WebSocket server.

- **Default URL:** `http://127.0.0.1:19400`
- **Port range:** 19400–19409 (10 attempts; actual port printed to stdout on startup)
- **Health check:** `GET /health` → `{ "status": "ok", "activeAgents": <number> }`
- **WebSocket:** `ws://localhost:<port>`
- **Auth:** In dev, `MCODE_AUTH_TOKEN=""` bypasses authentication entirely.

---

## Debug Scripts

| Script | What it does |
|--------|-------------|
| `bun run state:paths` | Print resolved data dir, DB path, and log directory |
| `bun run logs:tail` | Stream and follow today's log file (Ctrl+C to exit) |
| `bun run state:reset` | Wipe `MCODE_DATA_DIR` safely (dev-only, prompts for confirmation) |
| `bun run db:info` | Print DB path, schema version, and row counts for key tables |

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

## Bootstrap from Scratch

```sh
git clone <repo>
cd mcode
bun run setup       # Copy .env.example → .env, configure git hooks
bun install         # Install dependencies (also builds Electron ABI binding)
bun run doctor      # Verify all prerequisites pass
bun run dev:web     # Start development server
```
