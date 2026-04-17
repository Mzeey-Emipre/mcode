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

## Installing Pre-built Downloads

Mcode builds are currently **unsigned** while the project is in early development. Your OS will warn you before running them. This is expected and the binaries are safe — they are built in CI directly from this public repository (see [`.github/workflows/build-release.yml`](.github/workflows/build-release.yml)).

**Windows:** SmartScreen will show *"Windows protected your PC"*. Click **More info** → **Run anyway**.

**macOS:** Gatekeeper will say the app *"cannot be opened because the developer cannot be verified"*. Right-click the app → **Open** → **Open** in the dialog. Or run:

```bash
xattr -d com.apple.quarantine /Applications/Mcode.app
```

**Linux:** No warning. Make the AppImage executable with `chmod +x Mcode-*.AppImage`.

Proper code signing (Azure Trusted Signing for Windows, Apple Developer ID + notarization for macOS) is planned once the project matures.

## Notes

This project is in very early development. Expect bugs, breaking changes, and incomplete features. Use at your own risk for now.

## License

MIT
