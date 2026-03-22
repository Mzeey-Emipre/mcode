# Mcode

Performant AI agent orchestration desktop app. Built with Rust + Tauri.

## Features

- Manage multiple AI coding agent sessions across projects
- Full config inheritance from your Claude Code setup
- Git worktree isolation per thread
- Live streaming agent output
- Keyboard-driven UX

## Prerequisites

- [Claude Code CLI](https://claude.ai/download) installed and on PATH
- [Git](https://git-scm.com/) installed
- [Rust](https://rustup.rs/) (for building from source)
- [Node.js](https://nodejs.org/) 20+ (for frontend)

## Development

```bash
# Clone
git clone https://github.com/Mzeey-Emipre/mcode.git
cd mcode

# Setup
bash scripts/setup-env.sh
cd apps/web && npm install && cd ../..

# Run in dev mode
cargo tauri dev
```

## Architecture

See [Design Document](docs/plans/2026-03-22-mcode-design.md).

## License

MIT
