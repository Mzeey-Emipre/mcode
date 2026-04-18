# Mcode

Performant AI agent orchestration desktop app built with Electron + TypeScript.

For system architecture, data model, IPC flow, and diagrams, see **[ARCHITECTURE.md](ARCHITECTURE.md)**.

## Runtime Contract

Before working on this repo, read **[docs/agents/runtime.md](docs/agents/runtime.md)** for
the canonical list of startup commands, environment variables, runtime artifact locations,
and agent write boundaries.

Run `bun run setup` to bootstrap from a fresh clone.
Run `bun run doctor` to verify all prerequisites are installed.

## Directory Structure

```text
packages/
├── contracts/                  # Shared types and Zod schemas (zero runtime deps)
│   └── src/
│       ├── models/             # Workspace, Thread, Message, Attachment, enums
│       ├── events/             # AgentEvent discriminated union
│       ├── ws/                 # WebSocket RPC methods, push channels, protocol types
│       ├── providers/          # IAgentProvider, IProviderRegistry, ProviderId
│       ├── git.ts              # GitBranch, WorktreeInfo schemas
│       ├── github.ts           # PrInfo, PrDetail schemas
│       └── skills.ts           # SkillInfo schema
├── shared/                     # Runtime utilities shared across packages
│   └── src/
│       ├── logging/            # Winston logger with daily rotation
│       ├── paths/              # Mcode data directory resolution
│       └── git/                # Branch name sanitization, validation

apps/
├── server/                     # Standalone Node.js HTTP + WebSocket server
│   └── src/
│       ├── index.ts            # HTTP + WS server entry point
│       ├── container.ts        # tsyringe DI composition root
│       ├── services/           # Business logic (agent, thread, git, terminal, etc.)
│       ├── providers/          # AI provider adapters
│       │   ├── claude/         # Claude Agent SDK adapter
│       │   └── provider-registry.ts
│       ├── repositories/       # Data access (workspace, thread, message)
│       ├── store/              # SQLite setup and migrations
│       └── transport/          # WebSocket server, RPC router, push broadcasting
├── desktop/                    # Thin Electron shell (~500 lines)
│   └── src/main/
│       ├── main.ts             # Window, native IPC, lifecycle
│       ├── preload.ts          # contextBridge: desktopBridge + getPathForFile
│       └── server-manager.ts   # Server child process lifecycle
├── web/                        # React SPA (connects via WebSocket)
│   └── src/
│       ├── app/                # Routes and providers
│       ├── components/         # UI components (sidebar, chat, terminal, diff)
│       ├── stores/             # Zustand state management
│       ├── transport/          # WebSocket RPC client + push events
│       │   ├── ws-transport.ts # WebSocket RPC client + reconnection
│       │   ├── ws-events.ts    # Push channel listeners
│       │   └── desktop-bridge.d.ts # Type declarations for native bridge
│       └── lib/                # Utilities and types
docs/plans/                     # Design and planning docs (gitignored)
```

## Composer Status Bar

The `Composer` component (`apps/web/src/components/chat/Composer.tsx`) renders a status bar below the text input with mode and branch controls. The layout depends on the selected `ComposerMode`:

| Mode | Left | Right |
|------|------|-------|
| Direct | `ModeSelector` | `BranchPicker` |
| New worktree | `ModeSelector` | `BranchPicker` → `NamingModeSelector` → `BranchNameInput` |
| Existing worktree | `ModeSelector` | `WorktreePicker` |
| Locked (existing thread) | `ModeSelector` (locked) | `BranchPicker` (locked, read-only) |

Key components:
- **`BranchPicker`** – searchable branch dropdown, used in both direct and worktree modes
- **`ModeSelector`** – switches between Local / New worktree / Existing worktree
- **`NamingModeSelector`** – toggles Auto / Custom branch naming
- **`BranchNameInput`** – shows auto-generated or editable branch name
- **`WorktreePicker`** – searchable dropdown for existing worktrees

## UI Components

When working on frontend code, follow the component registry and rules in **[docs/guides/ui-components.md](docs/guides/ui-components.md)**. Always use existing shadcn primitives from `apps/web/src/components/ui/` before creating custom elements.

That guide's **Testing UI Changes** section lists the triggers that require a Playwright run (interactive components, responsive layout, accessibility semantics, theme tokens, `data-testid` changes, floating overlays, persisted first-paint state). Run `cd apps/web && bun run e2e` and report pass counts before claiming a UI change is done.

## Code Style

Always add JSDoc/TSDoc docstrings to all exported functions, components, types, and interfaces. AI-powered code reviews depend on these for context. At minimum include a one-line summary of what the symbol does.

## Zod Schemas in `packages/contracts`

All non-trivial Zod schemas must be wrapped with `lazySchema` to defer construction until first use, reducing module-load cost.

```ts
import { lazySchema } from "../utils/lazySchema.js";

export const MySchema = lazySchema(() =>
  z.object({ ... }),
);

export type MyType = z.infer<ReturnType<typeof MySchema>>;
```

Call sites invoke the schema as a function: `MySchema()`. See `AgentEventSchema`, `SettingsSchema`, and `WS_METHODS` for examples.

## Cross-Package Changes

This is a monorepo. When changing a function signature, return type, or shared interface, you must typecheck ALL packages that import it, not just the one you modified. Use `grep` to find all call sites across the monorepo before considering the change complete.

```sh
# Typecheck all packages after cross-cutting changes
(cd apps/server && npx tsc --noEmit)
(cd apps/web && npx tsc --noEmit)
(cd apps/desktop && npx tsc --noEmit)
```

## Commit Guidelines

Use [Conventional Commits](https://www.conventionalcommits.org/).
Types: feat, fix, refactor, docs, test, chore, perf, ci

Keep commits atomic. Each commit represents one logical change.

## Settings

When adding or modifying user-facing settings, follow the schema conventions in **[docs/guides/settings-schema.md](docs/guides/settings-schema.md)**. All settings use nested JSON with a max depth of 3 levels. See **[docs/settings/reference.md](docs/settings/reference.md)** for the full settings reference.

## Shiki in the Web Worker

Syntax highlighting runs in `apps/web/src/workers/shiki.worker.ts` via `@shikijs/langs/*` dynamic imports. Language grammars are lazy-loaded on demand and registered with a singleton highlighter.

**Do not add new `@shikijs/langs/*` imports without also declaring them in `optimizeDeps` in `apps/web/vite.config.ts`.** Vite's dep pre-bundler discovers dynamic imports at runtime in dev mode — any grammar not listed upfront causes Vite to re-run its optimizer mid-session, which forces a full page reload. To avoid this, either:

- Add the new lang to `optimizeDeps.include` (pre-bundle it at startup), or
- Keep all shiki packages under `optimizeDeps.exclude` (skip bundling entirely — what shiki's own docs recommend)

## Provider Architecture Convention

See **[docs/guides/provider-architecture.md](docs/guides/provider-architecture.md)**.

## Key Documentation

- **Architecture:** [ARCHITECTURE.md](ARCHITECTURE.md)
- **Electron docs:** https://www.electronjs.org/docs
- **esbuild docs:** https://esbuild.github.io/
- **better-sqlite3 docs:** https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md
- **tsyringe docs:** https://github.com/microsoft/tsyringe
- **shadcn/ui docs:** https://ui.shadcn.com/
- **Tailwind CSS 4:** https://tailwindcss.com/docs
- **Codex provider docs:** `apps/server/src/providers/codex/` - uses `codex app-server` JSON-RPC 2.0 protocol (see ARCHITECTURE.md)

## Performance Requirements

| Metric | Target |
|--------|--------|
| App idle memory | < 150MB |
| Max concurrent agents | 5 (configurable) |
| First 100 messages load | < 50ms |
| App startup to usable | < 2 seconds |
| Frontend bundle size | < 2MB gzipped |

## Database Migrations

```sh
cd apps/server

bun run db:migrate status          # Show applied and pending migrations
bun run db:migrate up              # Apply all pending migrations
bun run db:migrate down            # Roll back the last migration
bun run db:migrate new <name>      # Scaffold a new migration file
```

After scaffolding, implement `up()` and `down()` in the new file, then register it in `loadMigrations()` in `apps/server/src/store/database.ts`.

## Testing

- **Unit tests:** `bun run test` from root (Vitest, runs in apps/web and apps/desktop)
- **E2E tests:** `cd apps/web && bun run e2e` (Playwright, requires `bun run dev:web` or auto-starts)
- **E2E headed:** `cd apps/web && bun run e2e:headed` (opens browser to watch)
- **Screenshots:** E2E tests save screenshots to `apps/web/e2e/screenshots/` for visual verification

## Worktrees

Feature work uses git worktrees for isolation. Create them with:

```sh
git worktree add .worktrees/<name> -b <branch-name> main
```

Clean up finished worktrees with:

```sh
git worktree remove .worktrees/<name>
git worktree prune
```
