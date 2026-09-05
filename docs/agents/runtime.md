# Mcode Agent Runtime

Read the repository [agent guidance](../../AGENTS.md) before you work. This runbook covers the worktree-local runtime. For implementation and focused checks, see the [agent workflow](../guides/agent-workflow.md).

## Setup

Run `bun run setup` after a fresh clone. Run `bun install` if `node_modules` is absent. Run `bun run doctor` when you need to check local prerequisites.

## Start and stop

Use one command for the runtime you need:

| Command | Purpose |
|---|---|
| `bun run --shell system agent:up` | Start the server and web app in the background. |
| `bun run --shell system agent:up --desktop` | Start the server, web app, and Electron in the background. |
| `bun run --shell system agent:down` | Stop all owned server, web, and Electron components from either startup mode. |
| `bun run --shell system agent:reset` | Stop the runtime, recreate `.dev/db`, then restart the server and web app. |

Both startup commands wait for server health and web HTTP readiness, write `.dev/ports.json`, print that contract, then return. The desktop command also waits until Electron opens the managed app page.

Use `bun run --shell system` so Windows preserves the final startup contract. Run direct `dev:*` commands only for a specific foreground need, and keep them in the background.

## Runtime contract and ownership

Read `.dev/ports.json`. Do not derive ports. It contains `healthUrl`, `appUrl`, `logsDir`, `instanceToken`, `worktreeIdentity`, and `seedLogin`.

Use `seedLogin.authHeader` or the `mcode-auth` cookie for HTTP and WebSocket access. Treat `seedLogin.token` and `instanceToken` as secrets. Do not log, copy, or expose them.

The runtime owns these paths in the current worktree:

- `.dev/db/app.sqlite`: local database snapshot
- `.dev/fixture-repo/`: fixture repository
- `.dev/logs/`: server, web, and Electron logs
- `.dev/pids/`: owned server, web, and desktop PIDs
- `.dev/electron-agent-runtime.json`: managed Electron session record
- `.dev/verification/`: temporary verification artifacts

Do not write to `.dev/` in another worktree. Stop a runtime through `agent:down`; do not kill processes by name or path.

## Database and write boundaries

On first startup, `agent:up` snapshots local app data into `.dev/db/app.sqlite`. Later starts keep that local database. `agent:reset` creates a new snapshot. Use `bun run db:seed` after shutdown when you need to replace the snapshot.

Copy database data into the worktree. Do not symlink or write back to live data. Use SQLite backup mechanisms for a live source database; a plain copy can miss WAL changes.

Write in the repository working tree and this worktree's runtime paths. Do not edit `.env` files unless the task explicitly requires it.

## Focused verification

Run the smallest test that covers the changed behavior. Follow the repository [verification rules](../../AGENTS.md#verifying) and the [agent workflow](../guides/agent-workflow.md#focused-checks). For desktop-only behavior, use the [live Electron workflow](../../.agents/skills/electorn-live-testing/SKILL.md).
