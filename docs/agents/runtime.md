# Mcode Agent Runtime

Read the repository [agent guidance](../../AGENTS.md) before you work. This runbook covers the worktree-local runtime. For implementation and focused checks, see the [agent workflow](../guides/agent-workflow.md).

## Setup

Run `bun run setup` after a fresh clone. Run `bun install` if `node_modules` is absent. Run `bun run doctor` when you need to check local prerequisites.

## Setup and lifecycle

Provisioning and lifecycle are separate commands:

| Command | Purpose |
|---|---|
| `bun install` | Install dependencies before runtime setup. |
| `bun run agent:setup` | Safely snapshot the local Mcode database into `.dev/db/app.sqlite`, create or validate the fixture repository, and build runtime bundles. Run it only when an artifact is absent or stale, with the runtime stopped. |
| `bun run --shell system agent:up` | Start the server and web app in the background. Fails fast when setup artifacts are absent. Returns without readiness waits. |
| `bun run --shell system agent:up --desktop` | Start the server, web app, and Electron in the background. Returns without readiness waits. |
| `bun run agent:ready` | Read `.dev/ports.json` and wait for every started runtime surface. |
| `bun run --shell system agent:down` | Stop all owned server, web, and Electron components from either startup mode. |

Both startup commands spawn detached processes, write `.dev/ports.json`, print a redacted summary with endpoint URLs, worktree identity, and the contract path, and return. Use `--wait` only when a caller needs startup checks before it continues.

```powershell
# Windows PowerShell
bun run --shell system agent:up
bun run agent:ready
```

```bash
# macOS / Linux
bun run --shell system agent:up
bun run agent:ready
```

`agent:ready` polls `healthUrl` and `appUrl` from the contract. When `.dev/electron-agent-runtime.json` exists, it also verifies the managed worktree app page through the loopback CDP endpoint. The ports file assigns endpoints. It does not prove readiness on its own.

Use `bun run --shell system` so Windows preserves the final startup contract. Run direct `dev:*` commands only for a specific foreground need, and keep them in the background.

## Runtime contract and ownership

Read `.dev/ports.json`. Do not derive ports. It contains `healthUrl`, `appUrl`, `logsDir`, `instanceToken`, `worktreeIdentity`, and `seedLogin`.

Use `seedLogin.authHeader` or the `mcode-auth` cookie for HTTP and WebSocket access. Treat `seedLogin.token` and `instanceToken` as secrets. Do not log, copy, or expose them.

The runtime owns these paths in the current worktree:

- `.dev/db/app.sqlite`: local SQLite snapshot owned by setup
- `.dev/fixture-repo/`: fixture repository
- `.dev/logs/`: server, web, and Electron logs
- `.dev/pids/`: owned server, web, and desktop PIDs
- `.dev/electron-agent-runtime.json`: managed Electron session record
- `.dev/verification/`: temporary verification artifacts

Do not write to `.dev/` in another worktree. Stop a runtime through `agent:down`; do not kill processes by name or path.

## Database and write boundaries

`agent:setup` reads the local Mcode database through SQLite's backup path and writes only the worktree-local `.dev/db/app.sqlite`. It never modifies the source database. The snapshot can contain representative user projects, but product and runtime tests must select and mutate only `.dev/fixture-repo`. The server registers that fixture repository when it starts.

Write in the repository working tree and this worktree's runtime paths. Do not edit `.env` files unless the task explicitly requires it.

Linux desktop artifact verification caches the Ubuntu 22.04 image. The cache
key uses the Dockerfile hash. Edit
`apps/desktop/scripts/desktop-packaging/package-validation/Dockerfile.ubuntu22`
when verification dependencies change. APT requests time out after 20 seconds.
The image build limits package index updates to three minutes and package
installation to five minutes. The artifact install limits itself to three
minutes.

## Focused verification

Run the smallest test that covers the changed behavior. Follow the repository [verification rules](../../AGENTS.md#verifying) and the [agent workflow](../guides/agent-workflow.md#focused-checks). For desktop-only behavior, use the [live Electron workflow](../../.agents/skills/electorn-live-testing/SKILL.md).
