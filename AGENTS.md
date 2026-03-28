# Mcode

Performant AI agent orchestration desktop app built with Electron + TypeScript.

For system architecture, data model, IPC flow, and diagrams, see **[ARCHITECTURE.md](ARCHITECTURE.md)**.

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

## Code Style

Always add JSDoc/TSDoc docstrings to all exported functions, components, types, and interfaces. AI-powered code reviews depend on these for context. At minimum include a one-line summary of what the symbol does.

## Commit Guidelines

Use [Conventional Commits](https://www.conventionalcommits.org/).
Types: feat, fix, refactor, docs, test, chore, perf, ci

Keep commits atomic. Each commit represents one logical change.

## Key Documentation

- **Architecture:** [ARCHITECTURE.md](ARCHITECTURE.md)
- **Electron docs:** https://www.electronjs.org/docs
- **esbuild docs:** https://esbuild.github.io/
- **better-sqlite3 docs:** https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md
- **tsyringe docs:** https://github.com/microsoft/tsyringe
- **shadcn/ui docs:** https://ui.shadcn.com/
- **Tailwind CSS 4:** https://tailwindcss.com/docs

## Performance Requirements

| Metric | Target |
|--------|--------|
| App idle memory | < 150MB |
| Max concurrent agents | 5 (configurable) |
| First 100 messages load | < 50ms |
| App startup to usable | < 2 seconds |
| Frontend bundle size | < 2MB gzipped |

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
