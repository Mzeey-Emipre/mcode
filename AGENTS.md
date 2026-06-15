# Mcode

Performant AI agent orchestration desktop app built with Electron + TypeScript.

## Start here

1. **[CONTEXT.md](CONTEXT.md)** — domain glossary. Read first. Defines providers,
   workspaces, worktrees, composer modes (Direct / New worktree / Existing worktree),
   interaction modes (Plan / Build), threads, turns, narration segments, the handoff
   B/A/D ladder, and the app-side extensibility surfaces (Skill / Slash command / Hook).
   Most product terms in this repo are defined there, not in code.
2. **[ARCHITECTURE.md](ARCHITECTURE.md)** — system architecture, data model, IPC flow,
   directory layout, diagrams.
3. **[docs/agents/runtime.md](docs/agents/runtime.md)** — canonical startup commands,
   environment variables, runtime artifact locations, agent write boundaries.

Run `bun run setup` to bootstrap from a fresh clone.
Run `bun run doctor` to verify all prerequisites are installed.

## Agent skills

Per-repo configuration for the engineering skills (`to-issues`, `to-prd`, `triage`, `diagnose`, `tdd`, `improve-codebase-architecture`, `zoom-out`). These tell the skills how this repo tracks issues, what labels to apply during triage, and where domain docs live.

- **Issue tracker:** GitHub Issues at [Mzeey-Empire/mcode](https://github.com/Mzeey-Empire/mcode) via the `gh` CLI. See [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md).
- **Triage labels:** Canonical defaults (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See [`docs/agents/triage-labels.md`](docs/agents/triage-labels.md).
- **Domain docs:** Single-context: [`CONTEXT.md`](CONTEXT.md) + `docs/adr/`. See [`docs/agents/domain.md`](docs/agents/domain.md).

## Code Style

Always add JSDoc/TSDoc docstrings to all exported functions, components, types, and interfaces. AI-powered code reviews depend on these for context. At minimum include a one-line summary of what the symbol does.

Comments explain **why**, not **what**. The code itself shows what it does.

## Defensive Programming

Default to defensive code. Treat missing validation as a bug, not a shortcut.
Assume inputs, timing, and process state can be wrong unless proven at a boundary.

**Where to validate:** process and trust boundaries only. External input, filesystem
paths, IPC and WebSocket payloads, provider events, child-process environment,
persisted settings, and anything crossing a package or thread boundary.

**How to validate:** allowlists over blocklists; typed schemas (Zod in
`packages/contracts`); bounded values; explicit errors; exhaustive `switch` on
discriminated unions. Fail closed on security-sensitive paths.

**Where not to validate:** hot paths and inner loops. Normalize and validate once
at the boundary, then trust invariants inside. Do not re-parse, re-check, or
re-clamp the same value on every iteration.

**Bound all work:** cap payload and buffer sizes; limit recursion, fan-out, and
queue depth; set timeouts; cancel stale async work; evict oldest when a ring
buffer fills. Unbounded retention is never acceptable, even "temporarily."

**Performance:** defensive checks that could be expensive belong at the boundary
or behind a cheap guard. Measure before adding validation inside a hot path. When
in doubt, bound the work first, optimize second.

## UI Components

When working on frontend code, follow the component registry and rules in **[docs/guides/ui-components.md](docs/guides/ui-components.md)**. Always use existing shadcn primitives from `apps/web/src/components/ui/` before creating custom elements.

That guide's **Testing UI Changes** section lists the triggers that require a Playwright run (interactive components, responsive layout, accessibility semantics, theme tokens, `data-testid` changes, floating overlays, persisted first-paint state). Run `cd apps/web && bun run e2e` and report pass counts before claiming a UI change is done.

## Narrative Timeline

Before touching the Claude provider event pipeline, the agent-service, the `threadStore` tool-call lifecycle, or anything under `apps/web/src/components/chat/narrative/`, read **[docs/guides/narrative-pipeline.md](docs/guides/narrative-pipeline.md)**. It documents the end-to-end event flow and six specific traps (parent-id attribution for parallel sub-agents, `agentCallStack` lifecycle, volatile-state lifetime through `turn.persisted`, the DOM-mutation anti-pattern for the typing cursor, wall-clock snapshots in React, and the intentional step/sub-agent count overlap) that have already caused regressions on this codebase.

## Cross-Package Changes

This is a monorepo. When you change a function signature, return type, or shared interface, every package that imports it must still typecheck. Re-run `bun run verify` (it typechecks every package). Do not run `tsc --noEmit` per package — the workflow gate in [`docs/guides/agent-workflow.md`](docs/guides/agent-workflow.md) is the source of truth.

## Settings

When adding or modifying user-facing settings, follow the schema conventions in **[docs/guides/settings-schema.md](docs/guides/settings-schema.md)**. All settings use nested JSON with a max depth of 3 levels. See **[docs/settings/reference.md](docs/settings/reference.md)** for the full settings reference.

## Provider Architecture

See **[docs/guides/provider-architecture.md](docs/guides/provider-architecture.md)**.

## Zod schemas in `packages/contracts`

Wrap non-trivial schemas with `lazySchema` to defer construction until first use.
Call sites invoke the schema as a function: `MySchema()`. See `AgentEventSchema`,
`SettingsSchema`, and `WS_METHODS` for examples.

## Child process environment (server)

Integrated terminals and provider subprocesses use `EnvService` plus
`ProtectedEnvStore` and `ShellEnvResolver` under `apps/server/src/services/`. Keys
prefixed with `MCODE_`, `ELECTRON_`, or `BETTER_SQLITE3_` are snapshotted at
server boot and always win over shell or registry resolution. For one-off internal
variables without those prefixes, call `ProtectedEnvStore.protect("NAME")` during
server startup before spawning children.

## Subsystem guides

- **Database migrations / branch-specific DBs:** [`docs/guides/db-migrations.md`](docs/guides/db-migrations.md)
- **Shiki worker (syntax highlighting):** [`docs/guides/shiki-worker.md`](docs/guides/shiki-worker.md)
- **Chat fork handoff:** [`docs/guides/chat-fork-handoff.md`](docs/guides/chat-fork-handoff.md)
- **Codex provider (`codex app-server` JSON-RPC 2.0):** `apps/server/src/providers/codex/` and `ARCHITECTURE.md`

## Performance targets

| Metric | Target |
|--------|--------|
| App idle memory | < 150MB |
| Max concurrent agents | 5 (configurable) |
| First 100 messages load | < 50ms |
| App startup to usable | < 2 seconds |
| Frontend bundle size | < 2MB gzipped |

## Agent Development Workflow

@docs/guides/agent-workflow.md

## Verifying Behavior Changes

When a change affects what the app does, verify it in this order. This includes
UI behavior, IPC handlers, server endpoints, stores, and agent-service behavior.

1. Run it live first. Start the affected app from
   [docs/agents/runtime.md](docs/agents/runtime.md) with `bun run dev:web`,
   `bun run dev:server`, or `bun run dev:desktop`. Exercise the changed path as a
   user or client would. Observe the rendered UI, response body, IPC result, or
   persisted data. This live run is the main verification step.
2. Lock it in. Add or update a Playwright spec, desktop e2e spec, or focused test
   that asserts the observed outcome.
3. Run the regression floor. Run `bun run verify` and the relevant e2e suite,
   such as `bun run e2e`, `bun run verify:e2e`, or desktop e2e as needed.

Report all three: the live action and observed outcome, the assertion that
protects it, and the suite result. If the environment blocks live verification,
state that explicitly and list the manual check instead.
