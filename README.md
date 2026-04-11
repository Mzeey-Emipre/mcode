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

- **[Architecture](ARCHITECTURE.md)** - System design, data model, IPC flow, and diagrams

## Tech Stack

- Electron 35
- TypeScript
- React 19
- SQLite
- Claude Agent SDK
- shadcn/ui
- Tailwind CSS 4
- Zustand
- Bun

## Notes

This project is in very early development. Expect bugs, breaking changes, and incomplete features. Use at your own risk for now.

## License

MIT
