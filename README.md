# Mcode

AI agent orchestration desktop app. Manage multiple Claude coding sessions across projects with config inheritance and git worktree isolation.

## Features

- Multiple concurrent Claude agent sessions
- Full config inheritance from your Claude Code setup (`~/.claude/`, project `.claude/`)
- Git worktree isolation per thread
- Live streaming agent output with tool call rendering
- Keyboard-driven UX

## Quick Start

**Prerequisites:** [Bun](https://bun.sh/), [Git](https://git-scm.com/), [Claude Code CLI](https://claude.ai/download) on PATH

```bash
git clone https://github.com/Mzeey-Emipre/mcode.git
cd mcode
bash scripts/setup-env.sh
bun install
bun run dev:desktop
```

## Documentation

- **[Architecture](ARCHITECTURE.md)** - system design, data model, IPC flow, diagrams
- **[Design doc (original)](docs/plans/2026-03-22-mcode-design-tauri-original.md)** - historical Tauri-era design

## Tech Stack

Electron 35, TypeScript, React 19, SQLite (better-sqlite3), Claude Agent SDK, shadcn/ui, Tailwind CSS 4, Zustand, Turborepo + Bun.

## License

MIT
