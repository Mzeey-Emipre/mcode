# Mcode: Design Document

*Date: 2026-03-22*
*Status: Approved*
*Author: chuks-qua + Claude*

## Overview

Mcode is a desktop application for AI agent orchestration. It provides a performant, memory-efficient UI for managing multiple AI coding agent sessions across projects, with full config inheritance from the user's existing Claude Code setup.

Built with Rust (Tauri) for the desktop shell and React for the frontend. Designed from day one to support a web version via a shared frontend codebase and transport adapter pattern.

**MVP scope:** Claude Code as the sole agent provider, with a provider-agnostic architecture underneath.

**Name:** Mcode (Mzeey Empire)
**Org:** Mzeey-Emipre on GitHub
**License:** MIT

## Priorities

1. **UX** - The interface must be intuitive, fast, and keyboard-driven
2. **Performance/Memory** - Rust backend, minimal memory footprint, virtualized rendering
3. **Security** - Scoped Tauri capabilities, no arbitrary command execution

## 1. System Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    mcode-core (Rust crate)               │
│                                                         │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ Process Mgr  │  │ Config Loader│  │ Worktree Mgr  │  │
│  │ spawn/kill   │  │ ~/.claude/*  │  │ git2 crate    │  │
│  │ stream JSON  │  │ read-only    │  │ create/clean  │  │
│  └─────────────┘  └──────────────┘  └───────────────┘  │
│                                                         │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ Session Store│  │ Event Bus    │  │ Migration Mgr │  │
│  │ SQLite       │  │ tokio broad. │  │ refinery      │  │
│  │ single-writer│  │ typed events │  │ forward-only  │  │
│  └─────────────┘  └──────────────┘  └───────────────┘  │
├─────────────────────────────────────────────────────────┤
│                   mcode-api (Rust crate)                │
│         Thin API layer over mcode-core                  │
│         Exposes: commands, events, queries              │
├──────────────────────┬──────────────────────────────────┤
│   Tauri Shell        │         HTTP/WS Server           │
│   (Desktop app)      │         (Web app, v0.2+)         │
│   mcode-desktop      │         mcode-server             │
│   IPC commands       │         Axum + WebSocket         │
│   Channel streaming  │         SSE/WS streaming         │
├──────────────────────┴──────────────────────────────────┤
│                  React Frontend                         │
│          (shared, runs in both targets)                 │
│   shadcn/ui + Tailwind CSS 4 + Zustand + xterm.js      │
│                                                         │
│   Desktop: loads in Tauri webview                       │
│   Web: loads from mcode-server                          │
└─────────────────────────────────────────────────────────┘
```

**Separation of concerns:**

- `mcode-core` knows nothing about Tauri or HTTP. Pure Rust library.
- `mcode-api` adapts core for consumers. Defines the command/event interface.
- `mcode-desktop` (src-tauri) wires mcode-api to Tauri IPC.
- `mcode-server` (v0.2+) wires mcode-api to Axum HTTP/WebSocket.
- React frontend is one codebase with a transport adapter that auto-detects the environment.

## 2. Data Model

### Workspace

A git repository the user opens in Mcode.

| Field | Type | Description |
|-------|------|-------------|
| id | UUID | Primary key |
| name | String | Repository name |
| path | String | Absolute path to repo root |
| provider_config | JSON | Provider preferences (CLI path, model) |
| created_at | Timestamp | |
| updated_at | Timestamp | |

### Thread

A conversation/feature within a workspace.

| Field | Type | Description |
|-------|------|-------------|
| id | UUID | Primary key |
| workspace_id | FK | Parent workspace |
| title | String | Auto-generated or user-set |
| status | Enum | See ThreadStatus below |
| mode | Enum | `direct` or `worktree` |
| worktree_path | String? | Null when mode=direct |
| branch | String | Current branch (direct) or new branch (worktree) |
| issue_number | Int? | Optional GitHub issue link |
| pr_number | Int? | Set when agent creates PR |
| pr_status | Enum? | open, merged, closed |
| session_name | String | Claude session name for --resume |
| pid | Int? | Running claude process ID |
| created_at | Timestamp | |
| updated_at | Timestamp | |
| deleted_at | Timestamp? | Soft delete |

### ThreadStatus

```rust
enum ThreadStatus {
    Active,       // Agent is running
    Paused,       // User paused the agent
    Interrupted,  // App closed while agent was running
    Errored,      // Agent process crashed
    Archived,     // Hidden from default list
    Completed,    // Work finished
    Deleted,      // Soft deleted
}
```

### Message

A turn in the conversation.

| Field | Type | Description |
|-------|------|-------------|
| id | UUID | Primary key |
| thread_id | FK | Parent thread |
| role | Enum | user, assistant, system |
| content | Text | Message content |
| tool_calls | JSON? | Parsed from stream-json |
| files_changed | JSON? | List of edits in this turn |
| cost_usd | Float? | Token cost |
| tokens_used | Int? | Token count |
| timestamp | Timestamp | |
| sequence | Int | Ordering within thread |

### Storage

- SQLite via `rusqlite`, single `~/.mcode/mcode.db` file
- Single-writer pattern: one dedicated tokio task owns the connection
- Write commands via `mpsc` channel, results via `oneshot` channel
- No `SQLITE_BUSY` errors by design
- Forward-only migrations via `refinery` crate
- Back up database file before running migrations on app startup

## 3. Process Management

### Spawning an Agent

```bash
claude \
  --output-format stream-json \
  --session-name "mcode-{thread.id}" \
  --verbose \
  -p "user's prompt here"
```

For worktree threads, `cwd` is set to the worktree path.
For direct threads, `cwd` is the workspace path.

### Multi-Turn Conversations

Each user message spawns a new `claude -p` invocation with `--resume "mcode-{thread.id}"`. Claude resumes the named session with full history. Mcode stores messages for UI display but Claude owns the conversation state.

### Provider Abstraction

```rust
trait AgentProvider: Send + Sync {
    fn spawn(&self, config: SpawnConfig) -> Result<AgentProcess>;
    fn resume(&self, session: &SessionId) -> Result<AgentProcess>;
    fn capabilities(&self) -> ProviderCapabilities;
}

trait AgentProcess: Send {
    fn stream(&mut self) -> impl Stream<Item = AgentEvent>;
    fn send_input(&mut self, input: &str) -> Result<()>;
    fn terminate(&mut self) -> Result<ExitStatus>;
}
```

`ProviderCapabilities` declares what the provider supports (resume, tool use, streaming) so the UI can adapt. Claude CLI is the first implementation.

### Error Handling

Three process termination categories:

| Category | Trigger | Thread State | Action |
|----------|---------|-------------|--------|
| Clean exit | Code 0 | Completed | Show completion in UI |
| Error exit | Code non-zero | Errored | Preserve last output, show "Resume" button |
| Unexpected death | Signal/crash | Errored | Preserve buffered output, show "Resume" button |

- Partial streamed output is buffered and saved. User never loses visible content.
- Watchdog: if no stdout for 30s, show "stalled" indicator in UI.
- Resume action re-spawns with the same session name.

### Graceful Shutdown

When user closes the app with running agents:

1. Show informational dialog: "N agents are still working. They'll resume when you reopen Mcode." with a single [Continue] button.
2. If no agents running, close immediately with no dialog.
3. On Continue: send termination signal to all child processes, wait 5s, force kill.
4. Persist thread state as `interrupted` in SQLite before killing.
5. On next launch, detect `interrupted` threads and offer to resume.
6. Windows: use `TerminateProcess` (no POSIX signals). Abstract behind platform trait.

## 4. Config Inheritance

**Principle: Mcode never manages Claude's config. It just ensures Claude can see it.**

When spawning a claude process:

1. Set `HOME` env var to user's actual home directory (ensures `~/.claude/` is found)
2. Set `cwd` to workspace path (direct) or worktree path (worktree) (ensures project `.claude/` is found)
3. Claude CLI handles config resolution: Managed > CLI flags > Local > Project > User

**Mcode's own config** is completely separate:

```
~/.mcode/
  ├── mcode.db              # SQLite database
  ├── settings.json          # Mcode-specific settings
  │   ├── default_mode       # "direct" or "worktree"
  │   ├── default_model      # model preference
  │   ├── max_concurrent     # max agent processes (default: 5)
  │   ├── theme              # "system", "dark", "light"
  │   └── notifications      # enabled/disabled
  └── logs/                  # App logs (rotating)
```

No collision with Claude's config. No interference.

## 5. Concurrency Model

```
tokio async runtime (Tauri v2 uses it already)

Task topology:
  ┌─────────────────────────────────┐
  │  N agent reader tasks           │ ← 1 per running thread
  │  (reads stdout, parses JSON,    │
  │   forwards events to bus)       │
  ├─────────────────────────────────┤
  │  1 database writer task         │ ← owns rusqlite::Connection
  │  (receives writes via mpsc,     │
  │   returns results via oneshot)  │
  ├─────────────────────────────────┤
  │  1 event dispatcher task        │ ← broadcasts to UI
  │  (tokio::broadcast channel)     │
  ├─────────────────────────────────┤
  │  Tauri command handlers         │ ← on tokio thread pool
  │  (invoke from JS frontend)      │
  └─────────────────────────────────┘
```

## 6. State Synchronization

### Event Schema

```rust
enum McodeEvent {
    AgentOutput { thread_id: Uuid, content: String, tool_calls: Option<Value> },
    AgentStatusChanged { thread_id: Uuid, status: ThreadStatus },
    AgentError { thread_id: Uuid, error: String },
    AgentFinished { thread_id: Uuid, exit_code: i32 },
    ThreadCreated { thread: Thread },
    ThreadDeleted { thread_id: Uuid },
    WorkspaceUpdated { workspace: Workspace },
}
```

### Transport

- **Desktop (Tauri):** `emit()` from Rust, `listen()` in JS via Tauri event system
- **Web (v0.2+):** WebSocket or SSE from mcode-server

The frontend transport adapter abstracts over both:

```typescript
interface McodeTransport {
  // Commands (request/response)
  createWorkspace(path: string): Promise<Workspace>
  createThread(workspaceId: string, opts: ThreadOpts): Promise<Thread>
  sendMessage(threadId: string, content: string): Promise<void>
  stopThread(threadId: string): Promise<void>
  listWorkspaces(): Promise<Workspace[]>
  listThreads(workspaceId: string): Promise<Thread[]>
  getMessages(threadId: string): Promise<Message[]>

  // Events (streaming)
  onEvent(cb: (event: McodeEvent) => void): Unsubscribe
}
```

## 7. Frontend Architecture

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Components | shadcn/ui (base-mira style) + @base-ui/react |
| Styling | Tailwind CSS 4 + CVA + tailwind-merge |
| State | Zustand |
| Routing | TanStack Router (file-based) |
| Virtualization | @tanstack/react-virtual |
| Terminal | xterm.js |
| Diff rendering | @pierre/diffs or similar |
| Icons | Lucide React |
| Markdown | react-markdown + remark-gfm |
| Build | Vite |

### Component Structure

```
frontend/src/
  ├── app/
  │   ├── App.tsx
  │   ├── routes/
  │   │   ├── index.tsx                    # Workspace picker
  │   │   ├── workspace.$id.tsx            # Sidebar + thread layout
  │   │   └── workspace.$id.thread.$tid.tsx
  │   └── providers.tsx
  ├── components/
  │   ├── ui/                              # shadcn/ui primitives
  │   ├── sidebar/
  │   │   ├── WorkspaceList.tsx
  │   │   ├── ThreadList.tsx
  │   │   └── ThreadItem.tsx               # Status, title, branch, PR badge
  │   ├── chat/
  │   │   ├── MessageList.tsx              # Virtualized
  │   │   ├── MessageBubble.tsx
  │   │   ├── ToolCallBlock.tsx            # Collapsible
  │   │   ├── Composer.tsx
  │   │   └── StreamingIndicator.tsx
  │   ├── terminal/
  │   │   └── EmbeddedTerminal.tsx
  │   └── diff/
  │       └── DiffViewer.tsx
  ├── stores/
  │   ├── workspaceStore.ts
  │   ├── threadStore.ts
  │   └── settingsStore.ts
  ├── transport/
  │   ├── index.ts                         # Auto-detect environment
  │   ├── tauri.ts                         # @tauri-apps/api
  │   └── websocket.ts                     # fetch + WS
  └── lib/
      ├── stream-parser.ts
      └── types.ts
```

### Theme

- Dark and light modes via CSS custom properties
- Default to system `prefers-color-scheme`
- shadcn/ui base-mira style with zinc base color
- Persisted in settings

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+N` | New thread |
| `Ctrl+K` | Command palette (search threads, switch workspace) |
| `Ctrl+Enter` | Send message |
| `Ctrl+C` (empty input) | Interrupt running agent |
| `Ctrl+Shift+P` | Settings |
| `Ctrl+[1-9]` | Switch to thread N |
| `Escape` | Close panel / cancel |

Centralized shortcut registry. Discoverable via tooltips and command palette.

## 8. Performance Budgets

| Metric | Target |
|--------|--------|
| App idle memory (no agents) | < 150MB |
| Per-agent process overhead | Managed by OS (claude CLI) |
| Max concurrent agents | 5 (configurable) |
| Message list rendering | Virtualized, never render all DOM nodes |
| First 100 messages load | < 50ms |
| SQLite queries | Always paginated with LIMIT |
| App startup to usable | < 2 seconds |
| Frontend bundle size | < 2MB gzipped |

## 9. Security Model

### Tauri Capabilities (Scoped)

| Capability | Scope |
|-----------|-------|
| `fs` | Workspace directories + `~/.mcode/` only |
| `shell` | `claude` and `git` binaries only |
| `path` | All (needed for config resolution) |
| `window` | All |
| `dialog` | All |
| `notification` | All |

**Explicitly denied:** `http` (no arbitrary network requests), `clipboard` (grant only on user action).

The `shell` scope prevents arbitrary command execution. Only known binaries by name are allowed.

### Threat Model

Primary risk: arbitrary command execution through a malicious workspace. The shell scope must prevent this. The `mcode-server` variant (v0.2+) has a different threat model and will be documented separately.

## 10. Notifications

- Tauri notification plugin for OS-native notifications
- Trigger on: agent finished, agent errored (only when window is unfocused)
- In-app: toast system (shadcn/ui) for transient feedback
- Configurable: user can disable notifications in settings
- Default: notify only when window is not focused

## 11. Logging

- `tracing` crate with `tracing-subscriber` across all Rust crates
- Rotating log files in `app_log_dir()` (Tauri path API)
- Levels: ERROR and WARN always on, INFO in debug builds
- "Copy Debug Logs" button in settings for bug reports
- Structured JSON logging to file, human-readable to stderr in dev

## 12. Supported Platforms

| Platform | Architecture | Installer |
|----------|-------------|-----------|
| Windows 10+ | x64 | .msi (WiX) + .exe (NSIS) |
| macOS 12+ | x64 + ARM (universal) | .dmg |
| Linux | x64 | AppImage + .deb |

**Prerequisites:** `claude` CLI on PATH, `git` installed.

## 13. Repository Structure

```
mcode/
├── .github/
│   ├── workflows/
│   │   ├── ci.yml
│   │   ├── release-please.yml
│   │   └── build-release.yml
│   ├── pull_request_template.md
│   └── CODEOWNERS
├── .githooks/
│   └── post-checkout               # .env.example → .env if missing
├── crates/
│   ├── mcode-core/
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── process/
│   │       │   ├── mod.rs
│   │       │   ├── manager.rs
│   │       │   └── stream.rs
│   │       ├── config/
│   │       │   ├── mod.rs
│   │       │   └── claude.rs
│   │       ├── workspace/
│   │       │   ├── mod.rs
│   │       │   ├── workspace.rs
│   │       │   └── thread.rs
│   │       ├── worktree/
│   │       │   └── mod.rs
│   │       ├── store/
│   │       │   ├── mod.rs
│   │       │   ├── models.rs
│   │       │   └── migrations/
│   │       └── events.rs
│   ├── mcode-api/
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── commands.rs
│   │       ├── events.rs
│   │       └── queries.rs
│   └── mcode-server/                # v0.2+
│       ├── Cargo.toml
│       └── src/
│           ├── main.rs
│           ├── routes.rs
│           └── ws.rs
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── build.rs
│   ├── capabilities/
│   │   └── default.json
│   ├── icons/
│   └── src/
│       ├── main.rs
│       └── lib.rs
├── frontend/
│   ├── package.json
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── components.json
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── app/
│       ├── components/
│       ├── stores/
│       ├── transport/
│       └── lib/
├── www/                             # Marketing page (v0.3+)
│   └── .gitkeep
├── docs/
│   └── plans/
│       └── 2026-03-22-mcode-design.md
├── scripts/
│   └── setup-env.sh
├── Cargo.toml                       # Workspace root
├── Cargo.lock
├── CLAUDE.md
├── AGENTS.md
├── .claude/
│   ├── settings.json
│   └── agents/
│       └── security-reviewer.md
├── .env.example
├── .gitignore
├── release-please-config.json
├── .release-please-manifest.json
├── CHANGELOG.md
├── LICENSE
└── README.md
```

## 14. CI/CD

### CI (on every PR)

| Job | What |
|-----|------|
| `pr-title` | Validate conventional commit format |
| `lint-rust` | `cargo fmt --check` + `cargo clippy` |
| `test-rust` | `cargo test` across all crates |
| `lint-frontend` | `npm run lint` + `npm run typecheck` |
| `test-frontend` | `npm run test` (Vitest) |
| `build-check` | `cargo build` (Tauri compile verification) |

### Release (on merge to main)

1. release-please creates/updates release PR with version bumps and changelog
2. On release PR merge, release-please creates a GitHub Release
3. `build-release.yml` triggers, builds Tauri binaries for all platforms
4. Binaries attached to GitHub Release

### Branch Protection (main)

- PRs only, zero direct pushes
- Require all CI checks to pass
- Require 1 approval minimum
- Squash merge only
- Bypass: release-please bot only (GitHub App)
- No force pushes, no deletions

### PR Template

```markdown
## What
<Brief description>

## Why
<Motivation and context>

## Key Changes
- Change 1
- Change 2

## Config Changes
<!-- If any env vars, settings, or secrets were added/changed/removed -->
None
```

### Release-Please Config

Files updated on release:
- `crates/mcode-core/Cargo.toml` (version)
- `crates/mcode-api/Cargo.toml` (version)
- `src-tauri/Cargo.toml` (version)
- `src-tauri/tauri.conf.json` (version via extra-files)
- `frontend/package.json` (version)
- `Cargo.lock`
- `CHANGELOG.md`
- `.release-please-manifest.json`

## 15. Deferred (v0.2+)

| Feature | Notes |
|---------|-------|
| Web version (mcode-server) | Axum + WebSocket, same React frontend |
| Additional providers | Codex CLI, Gemini CLI via AgentProvider trait |
| Split monitoring view | 2-4 agents side by side |
| Dashboard | Sprint overview with progress bars |
| Search | SQLite FTS5 across threads/messages |
| Auto-update | Tauri updater plugin + GitHub Releases |
| Import/export | JSON thread format |
| Marketing page | Static site in www/ |
| Minimize to tray | Keep agents running when window closed |
| Deep GitHub integration | Issue import, PR review status |
