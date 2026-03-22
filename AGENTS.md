# Mcode

Performant AI agent orchestration desktop app built with Rust + Tauri.

## Directory Structure

```text
crates/
├── mcode-core/             # Pure Rust library (process mgmt, store, events)
│   └── src/
│       ├── process/        # Claude CLI spawn, stream-json parsing
│       ├── config/         # Config discovery (read-only)
│       ├── workspace/      # Workspace + thread management
│       ├── worktree/       # Git worktree operations (git2)
│       ├── store/          # SQLite persistence + migrations
│       └── events.rs       # Typed event bus
├── mcode-api/              # Adapter layer (commands, events, queries)
│   └── src/
└── mcode-server/           # Web server (v0.2+, Axum + WebSocket)
src-tauri/                  # Tauri desktop shell
frontend/                   # React app (shared desktop + web)
├── src/
│   ├── app/               # Routes and providers
│   ├── components/        # UI components (sidebar, chat, terminal, diff)
│   ├── stores/            # Zustand state management
│   ├── transport/         # Tauri IPC / WebSocket adapter
│   └── lib/               # Utilities and types
www/                        # Marketing page (v0.3+)
docs/plans/                 # Design and planning docs
```

## Tech Stack

- **Backend:** Rust (tokio, rusqlite, git2, serde, tracing)
- **Desktop:** Tauri v2 (WebView2 on Windows, WKWebView on macOS)
- **Frontend:** React 19, Vite, shadcn/ui, Tailwind CSS 4, Zustand
- **Database:** SQLite (single-writer pattern, refinery migrations)
- **Testing:** cargo test (Rust), Vitest (frontend)

## Commit Guidelines

Use [Conventional Commits](https://www.conventionalcommits.org/).
Types: feat, fix, refactor, docs, test, chore, perf, ci

Keep commits atomic. Each commit represents one logical change.

## Key Documentation

- **Design doc:** docs/plans/2026-03-22-mcode-design.md
- **Implementation plan:** docs/plans/2026-03-22-mcode-implementation-plan.md
- **Tauri v2 docs:** https://v2.tauri.app/
- **shadcn/ui docs:** https://ui.shadcn.com/
- **Tailwind CSS 4:** https://tailwindcss.com/docs
- **rusqlite docs:** https://docs.rs/rusqlite/latest/rusqlite/
- **git2 docs:** https://docs.rs/git2/latest/git2/

## Performance Requirements

| Metric | Target |
|--------|--------|
| App idle memory | < 150MB |
| Max concurrent agents | 5 (configurable) |
| First 100 messages load | < 50ms |
| App startup to usable | < 2 seconds |
| Frontend bundle size | < 2MB gzipped |

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
