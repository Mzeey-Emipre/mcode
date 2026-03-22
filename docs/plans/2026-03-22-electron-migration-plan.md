# Electron + Bun Migration Plan

Port Mcode from Tauri (Rust backend) to Electron with Bun as package manager/task runner.

## What Stays vs What Changes

| Component | Action | Notes |
|-----------|--------|-------|
| `apps/sidecar/` | **Keep as-is** | Already Node.js, zero changes |
| `apps/web/` (React) | **Keep, add transport** | Add Electron IPC adapter alongside Tauri one |
| SQL schema | **Copy verbatim** | Same 3 tables, same indexes |
| `crates/` (Rust) | **Archive** | Port logic to TypeScript, keep for reference |
| `apps/desktop/` (Tauri) | **Replace** | New Electron main process |

## New Directory Structure

```
apps/desktop/
├── package.json              # Electron + better-sqlite3 + electron-vite
├── electron.vite.config.ts   # Build config (main + preload + renderer)
├── tsconfig.json
└── src/
    ├── main/
    │   ├── index.ts           # Entry: BrowserWindow, IPC handlers, lifecycle
    │   ├── app-state.ts       # Central orchestrator (ports commands.rs)
    │   ├── models.ts          # Shared types
    │   ├── sidecar/
    │   │   ├── client.ts      # JSON-RPC over stdin/stdout
    │   │   └── types.ts       # SidecarEvent types
    │   ├── store/
    │   │   ├── database.ts    # better-sqlite3 init + migrations
    │   │   └── migrations/
    │   │       └── V001__initial_schema.sql
    │   ├── repositories/
    │   │   ├── workspace-repo.ts
    │   │   ├── thread-repo.ts
    │   │   └── message-repo.ts
    │   ├── worktree.ts        # Shell git commands
    │   ├── config.ts          # Claude config discovery
    │   └── logger.ts          # Rotating file logger
    └── preload/
        └── index.ts           # contextBridge IPC exposure

apps/web/src/transport/
├── electron.ts               # NEW: Electron IPC transport
├── electron-events.ts        # NEW: Electron event listener
├── electron.d.ts             # NEW: window.electronAPI types
├── index.ts                  # MODIFIED: add isElectron() detection
├── events.ts                 # MODIFIED: dispatch to Tauri or Electron
├── tauri.ts                  # KEPT for reference
└── types.ts                  # UNCHANGED
```

## Parallel Execution (5 Agents)

| Agent | Work | Depends On |
|-------|------|-----------|
| **1: Electron Shell** | package.json, electron.vite.config.ts, tsconfig.json, preload, main skeleton | Nothing |
| **2: Data Layer** | models.ts, database.ts, migration SQL, 3 repository files | Nothing |
| **3: Infrastructure** | sidecar/types.ts, sidecar/client.ts, worktree.ts, config.ts, logger.ts | Nothing |
| **4: Frontend Transport** | electron.ts, electron-events.ts, electron.d.ts, index.ts, events.ts | Nothing |
| **5: AppState + IPC** | app-state.ts, expand main/index.ts with IPC handlers | Agents 2+3 |

Agent 5 waits for 2+3, then wires everything together. Estimated total: ~70-80 min.

## Key Technical Decisions

- **Bun** is package manager + task runner only. Electron's main process runs on Electron's bundled Node.js (standard approach, same as Cursor/VS Code)
- **better-sqlite3** for SQLite (needs `electron-rebuild` for native binding)
- **Shell `git`** commands instead of git2/libgit2
- **Structured clone** over Electron IPC (no JSON.stringify/parse needed, unlike Tauri)
- **winston** for rotating file logs (replacing tracing-appender)

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| better-sqlite3 native build on Windows | High | electron-rebuild; fallback to sql.js |
| Bun + Electron compatibility | High | Bun is only pkg manager, not runtime |
| Sidecar protocol mismatch | Medium | Same JSON-RPC; integration test exists |
| Git not on PATH (Windows) | Medium | Check on startup, show error |

## Success Criteria

- `bun run dev` launches Electron with Mcode UI
- All 14 IPC commands work (workspace/thread/message CRUD, agent control)
- Streaming chat responses work (send message, get response)
- Worktree creation/deletion works
- Close dialog shows when agents are running
- Frontend tests pass unchanged
- App idle memory < 150MB
- Same SQLite DB file compatible between old and new versions
