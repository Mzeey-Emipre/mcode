# Mcode

AI agent orchestration desktop app. Run coding sessions across multiple providers and projects with git worktree isolation.

## Features

- **Multi-provider** - Claude, Codex, and GitHub Copilot. Enable or disable each provider in settings.
- **CLI path configuration** - Point each provider to a custom CLI binary path, or let Mcode find it on your system PATH.
- **Concurrent sessions** - Run multiple agent sessions in parallel across different projects.
- **Config inheritance** - Picks up your existing provider config (`~/.claude/`, project `.claude/`, etc.).
- **Worktree isolation** - Each thread gets its own git worktree so agents don't step on each other.
- **Live streaming** - Agent output and tool calls stream in real time.
- **Keyboard-driven UX**

## Quick Start

**Prerequisites:** [Bun](https://bun.sh/), [Git](https://git-scm.com/), and Node.js 24.18.0.
The exact Node.js version in [`.node-version`](.node-version) prevents native
module ABI mismatches. Before installing dependencies, use your Node version
manager to install and select that version. Version managers that support
`.node-version` can select it automatically.

You also need at least one supported provider CLI installed:

| Provider | Install | Min version |
|----------|---------|-------------|
| [Claude Code](https://claude.ai/download) | `npm i -g @anthropic-ai/claude-code` | — |
| [Codex](https://github.com/openai/codex) | `npm i -g @openai/codex` | 0.37.0 |
| [GitHub Copilot](https://github.com/github/copilot) | `npm i -g @github/copilot` | — |

Provider CLIs do not need to be on your system PATH. You can set a custom binary path per provider in **Settings > Providers**.

```bash
git clone https://github.com/Mzeey-Emipre/mcode.git
cd mcode
bash scripts/setup-env.sh
bun install
bun run dev:desktop
```

## Documentation

**Working on this codebase (humans or AI agents)?** Start here:

- **[AGENTS.md](AGENTS.md)** - Repo-wide conventions, harness setup, workflow gates. Routes to everything else.
- **[CONTEXT.md](CONTEXT.md)** - Domain glossary (providers, threads, forks, worktrees, handoff pipeline). Read before naming or reasoning about product concepts.

**Reference docs:**

- **[Architecture](ARCHITECTURE.md)** - System design, data model, IPC flow, and diagrams
- **[Provider architecture](docs/guides/provider-architecture.md)** - How providers are wired up
- **[Settings reference](docs/settings/reference.md)** - All configurable settings

## Tech Stack

- Electron 35
- TypeScript
- React 19
- SQLite
- Claude Code CLI / Claude Agent SDK (provider adapters for Codex, Copilot)
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
