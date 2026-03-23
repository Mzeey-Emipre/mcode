# Mcode

Performant AI agent orchestration desktop app built with Electron + TypeScript.

For system architecture, data model, IPC flow, and diagrams, see **[ARCHITECTURE.md](ARCHITECTURE.md)**.

## Commit Guidelines

Use [Conventional Commits](https://www.conventionalcommits.org/).
Types: feat, fix, refactor, docs, test, chore, perf, ci

Keep commits atomic. Each commit represents one logical change.

## Key Documentation

- **Architecture:** [ARCHITECTURE.md](ARCHITECTURE.md)
- **Original design doc:** [docs/plans/2026-03-22-mcode-design-tauri-original.md](docs/plans/2026-03-22-mcode-design-tauri-original.md)
- **Electron docs:** https://www.electronjs.org/docs
- **electron-vite docs:** https://electron-vite.org/
- **better-sqlite3 docs:** https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md
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
