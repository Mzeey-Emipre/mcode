# Mcode Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a performant Rust + Tauri desktop app for AI agent orchestration with full Claude Code config inheritance.

**Architecture:** Cargo workspace with three crates (mcode-core, mcode-api, src-tauri) plus a React frontend. Bottom-up build: repo scaffolding, then core data layer, process management, Tauri wiring, and finally the React UI.

**Tech Stack:** Rust (tokio, rusqlite, git2, serde, tracing), Tauri v2, React 19, Vite, shadcn/ui, Tailwind CSS 4, Zustand, TanStack Router, xterm.js

**Design doc:** `docs/plans/2026-03-22-mcode-design.md`

---

## Phase 1: Repository Scaffolding

Everything needed to `cargo build` and `npm run dev` with an empty app.

---

### Task 1: Create GitHub repo with branch protection

**Files:**
- Create: (GitHub remote)

**Step 1: Create the repo on GitHub**

Run:
```bash
cd /c/src/mcode
gh repo create Mzeey-Emipre/mcode --public --source=. --remote=origin --push --description "Performant AI agent orchestration desktop app. T3Code alternative built with Rust + Tauri."
```

**Step 2: Set branch protection on main**

Run:
```bash
gh api repos/Mzeey-Emipre/mcode/rulesets -X POST --input - <<'EOF'
{
  "name": "main-protection",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": {
      "include": ["refs/heads/main"],
      "exclude": []
    }
  },
  "rules": [
    { "type": "pull_request", "parameters": { "required_approving_review_count": 1, "dismiss_stale_reviews_on_push": true, "require_last_push_approval": false } },
    { "type": "required_status_checks", "parameters": { "strict_required_status_checks_policy": true, "required_status_checks": [{"context": "lint-rust"}, {"context": "test-rust"}, {"context": "lint-frontend"}, {"context": "test-frontend"}, {"context": "build-check"}, {"context": "pr-title"}] } },
    { "type": "non_fast_forward" },
    { "type": "deletion" }
  ],
  "bypass_actors": []
}
EOF
```

Note: Add release-please bot bypass after setting up the GitHub App.

**Step 3: Set squash merge only**

Run:
```bash
gh api repos/Mzeey-Emipre/mcode -X PATCH -f allow_squash_merge=true -f allow_merge_commit=false -f allow_rebase_merge=false -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY -f delete_branch_on_merge=true
```

---

### Task 2: Cargo workspace and crate scaffolding

**Files:**
- Create: `Cargo.toml` (workspace root)
- Create: `crates/mcode-core/Cargo.toml`
- Create: `crates/mcode-core/src/lib.rs`
- Create: `crates/mcode-api/Cargo.toml`
- Create: `crates/mcode-api/src/lib.rs`

**Step 1: Create workspace root Cargo.toml**

```toml
# Cargo.toml
[workspace]
resolver = "2"
members = [
  "crates/mcode-core",
  "crates/mcode-api",
  "src-tauri",
]

[workspace.package]
version = "0.1.0"
edition = "2021"
license = "MIT"
repository = "https://github.com/Mzeey-Emipre/mcode"

[workspace.dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
uuid = { version = "1", features = ["v4", "serde"] }
thiserror = "2"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["json", "env-filter"] }
rusqlite = { version = "0.32", features = ["bundled"] }
refinery = { version = "0.8", features = ["rusqlite"] }
git2 = "0.19"
chrono = { version = "0.4", features = ["serde"] }
anyhow = "1"
```

**Step 2: Create mcode-core crate**

```toml
# crates/mcode-core/Cargo.toml
[package]
name = "mcode-core"
version.workspace = true
edition.workspace = true
license.workspace = true
description = "Core library for Mcode agent orchestration"

[dependencies]
serde.workspace = true
serde_json.workspace = true
tokio.workspace = true
uuid.workspace = true
thiserror.workspace = true
tracing.workspace = true
rusqlite.workspace = true
refinery.workspace = true
git2.workspace = true
chrono.workspace = true
anyhow.workspace = true
```

```rust
// crates/mcode-core/src/lib.rs
pub mod events;

pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_is_set() {
        assert!(!version().is_empty());
    }
}
```

```rust
// crates/mcode-core/src/events.rs
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum McodeEvent {
    AgentOutput {
        thread_id: Uuid,
        content: String,
        tool_calls: Option<serde_json::Value>,
    },
    AgentStatusChanged {
        thread_id: Uuid,
        status: String,
    },
    AgentError {
        thread_id: Uuid,
        error: String,
    },
    AgentFinished {
        thread_id: Uuid,
        exit_code: i32,
    },
}
```

**Step 3: Create mcode-api crate**

```toml
# crates/mcode-api/Cargo.toml
[package]
name = "mcode-api"
version.workspace = true
edition.workspace = true
license.workspace = true
description = "API adapter layer for Mcode"

[dependencies]
mcode-core = { path = "../mcode-core" }
serde.workspace = true
serde_json.workspace = true
tokio.workspace = true
uuid.workspace = true
tracing.workspace = true
anyhow.workspace = true
```

```rust
// crates/mcode-api/src/lib.rs
pub use mcode_core;

pub fn api_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_version_matches_core() {
        assert_eq!(api_version(), mcode_core::version());
    }
}
```

**Step 4: Verify it compiles**

Run: `cargo build`
Expected: Compiles with no errors.

Run: `cargo test`
Expected: 2 tests pass.

**Step 5: Commit**

```bash
git add Cargo.toml Cargo.lock crates/
git commit -m "chore: scaffold Cargo workspace with mcode-core and mcode-api crates"
```

---

### Task 3: Initialize Tauri desktop shell

**Files:**
- Create: `src-tauri/Cargo.toml`
- Create: `src-tauri/tauri.conf.json`
- Create: `src-tauri/build.rs`
- Create: `src-tauri/src/main.rs`
- Create: `src-tauri/src/lib.rs`
- Create: `src-tauri/capabilities/default.json`
- Create: `src-tauri/icons/` (Tauri default icons)

**Step 1: Initialize Tauri in the existing project**

Run:
```bash
cd /c/src/mcode
cargo install create-tauri-app --locked
npm create tauri-app@latest -- --template react-ts --manager npm --dir . --force
```

If the interactive scaffolder doesn't support `--dir .`, manually create the files.

**Step 2: Update src-tauri/Cargo.toml to use workspace dependencies**

```toml
# src-tauri/Cargo.toml
[package]
name = "mcode-desktop"
version.workspace = true
edition.workspace = true
license.workspace = true
description = "Mcode desktop application"

[lib]
name = "mcode_desktop"
crate-type = ["lib", "cdylib", "staticlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
mcode-api = { path = "../crates/mcode-api" }
tauri = { version = "2", features = [] }
tauri-plugin-shell = "2"
tauri-plugin-dialog = "2"
tauri-plugin-notification = "2"
tauri-plugin-fs = "2"
serde.workspace = true
serde_json.workspace = true
tokio.workspace = true
tracing.workspace = true
tracing-subscriber.workspace = true
```

**Step 3: Write src-tauri/src/lib.rs**

```rust
// src-tauri/src/lib.rs
use tracing_subscriber::{fmt, EnvFilter};

#[tauri::command]
fn get_version() -> String {
    mcode_api::api_version().to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    tracing::info!("Mcode v{} starting", mcode_api::api_version());

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![get_version])
        .run(tauri::generate_context!())
        .expect("error while running Mcode");
}
```

```rust
// src-tauri/src/main.rs
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    mcode_desktop::run();
}
```

```rust
// src-tauri/build.rs
fn main() {
    tauri_build::build();
}
```

**Step 4: Configure tauri.conf.json**

```json
{
  "$schema": "https://raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri-cli/schema.json",
  "productName": "Mcode",
  "version": "0.1.0",
  "identifier": "com.mzeey.mcode",
  "build": {
    "frontendDist": "../frontend/dist",
    "devUrl": "http://localhost:5173",
    "beforeDevCommand": "cd ../frontend && npm run dev",
    "beforeBuildCommand": "cd ../frontend && npm run build"
  },
  "app": {
    "withGlobalTauri": true,
    "windows": [
      {
        "title": "Mcode",
        "width": 1280,
        "height": 800,
        "minWidth": 800,
        "minHeight": 600,
        "decorations": true
      }
    ],
    "security": {
      "csp": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'"
    }
  }
}
```

**Step 5: Configure Tauri capabilities**

```json
// src-tauri/capabilities/default.json
{
  "$schema": "https://raw.githubusercontent.com/nicegui-org/nicegui/main/tauri/capabilities-schema.json",
  "identifier": "default",
  "description": "Default capabilities for Mcode",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "dialog:default",
    "notification:default",
    "shell:allow-spawn",
    "shell:allow-execute",
    "fs:allow-read",
    "fs:allow-write",
    "fs:allow-exists",
    "fs:allow-mkdir",
    {
      "identifier": "shell:allow-spawn",
      "allow": [
        { "name": "claude", "cmd": "claude", "args": true },
        { "name": "git", "cmd": "git", "args": true }
      ]
    }
  ]
}
```

**Step 6: Verify it compiles**

Run: `cargo build`
Expected: Compiles (frontend not yet built, so Tauri dev won't fully work yet).

**Step 7: Commit**

```bash
git add src-tauri/
git commit -m "chore: add Tauri desktop shell with security capabilities"
```

---

### Task 4: Initialize React frontend

**Files:**
- Create: `frontend/package.json`
- Create: `frontend/vite.config.ts`
- Create: `frontend/tsconfig.json`
- Create: `frontend/index.html`
- Create: `frontend/src/main.tsx`
- Create: `frontend/src/app/App.tsx`
- Create: `frontend/components.json`

**Step 1: Scaffold React + Vite project**

Run:
```bash
cd /c/src/mcode/frontend
npm create vite@latest . -- --template react-ts
```

**Step 2: Install core dependencies**

Run:
```bash
cd /c/src/mcode/frontend
npm install @tauri-apps/api @tauri-apps/plugin-shell @tauri-apps/plugin-dialog @tauri-apps/plugin-notification @tauri-apps/plugin-fs
npm install zustand @tanstack/react-router @tanstack/react-virtual react-markdown remark-gfm lucide-react
npm install -D tailwindcss @tailwindcss/vite class-variance-authority tailwind-merge clsx
npm install -D @types/react @types/react-dom typescript vitest @testing-library/react @testing-library/jest-dom jsdom
```

**Step 3: Configure Vite for Tauri**

```typescript
// frontend/vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 5174 } : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: "esnext",
    minify: "esbuild",
    sourcemap: false,
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: "./src/test-setup.ts",
  },
});
```

**Step 4: Set up Tailwind CSS 4**

```css
/* frontend/src/index.css */
@import "tailwindcss";

@custom-variant dark (&:is(.dark *));

@theme {
  --color-background: oklch(1 0 0);
  --color-foreground: oklch(0.145 0 0);
  --color-card: oklch(1 0 0);
  --color-card-foreground: oklch(0.145 0 0);
  --color-primary: oklch(0.488 0.217 264);
  --color-primary-foreground: oklch(0.984 0 0);
  --color-muted: oklch(0.961 0 0);
  --color-muted-foreground: oklch(0.556 0 0);
  --color-border: oklch(0.922 0 0);
  --color-ring: oklch(0.488 0.217 264);
  --radius-sm: 0.25rem;
  --radius-md: 0.375rem;
  --radius-lg: 0.5rem;

  --font-sans: "DM Sans", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "SF Mono", "Cascadia Code", "Consolas", monospace;
}

.dark {
  --color-background: oklch(0.145 0 0);
  --color-foreground: oklch(0.984 0 0);
  --color-card: oklch(0.205 0 0);
  --color-card-foreground: oklch(0.984 0 0);
  --color-primary: oklch(0.588 0.217 264);
  --color-primary-foreground: oklch(0.145 0 0);
  --color-muted: oklch(0.269 0 0);
  --color-muted-foreground: oklch(0.708 0 0);
  --color-border: oklch(0.269 0 0);
  --color-ring: oklch(0.588 0.217 264);
}
```

**Step 5: Create minimal App component**

```tsx
// frontend/src/app/App.tsx
import { useEffect, useState } from "react";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

const isTauri = (): boolean => typeof window.__TAURI_INTERNALS__ !== "undefined";

export function App() {
  const [version, setVersion] = useState<string>("");

  useEffect(() => {
    if (isTauri()) {
      import("@tauri-apps/api/core").then(({ invoke }) => {
        invoke<string>("get_version").then(setVersion);
      });
    }
  }, []);

  return (
    <div className="flex h-screen items-center justify-center bg-background text-foreground">
      <div className="text-center">
        <h1 className="text-4xl font-bold">Mcode</h1>
        <p className="mt-2 text-muted-foreground">
          AI Agent Orchestration
        </p>
        {version && (
          <p className="mt-1 text-sm text-muted-foreground">v{version}</p>
        )}
      </div>
    </div>
  );
}
```

```tsx
// frontend/src/main.tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

```html
<!-- frontend/index.html -->
<!doctype html>
<html lang="en" class="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Mcode</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

**Step 6: Add test setup and a smoke test**

```typescript
// frontend/src/test-setup.ts
import "@testing-library/jest-dom/vitest";
```

```typescript
// frontend/src/__tests__/App.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { App } from "../app/App";

describe("App", () => {
  it("renders the app title", () => {
    render(<App />);
    expect(screen.getByText("Mcode")).toBeInTheDocument();
  });

  it("renders the subtitle", () => {
    render(<App />);
    expect(screen.getByText("AI Agent Orchestration")).toBeInTheDocument();
  });
});
```

**Step 7: Verify frontend builds and tests pass**

Run: `cd /c/src/mcode/frontend && npm run build`
Expected: Builds successfully to `frontend/dist/`.

Run: `cd /c/src/mcode/frontend && npx vitest run`
Expected: 2 tests pass.

**Step 8: Verify full Tauri dev works**

Run: `cd /c/src/mcode && cargo tauri dev`
Expected: Window opens showing "Mcode" title with version number.

**Step 9: Commit**

```bash
git add frontend/
git commit -m "chore: scaffold React frontend with Tailwind CSS 4 and Tauri integration"
```

---

### Task 5: Project configuration files

**Files:**
- Create: `CLAUDE.md`
- Create: `AGENTS.md`
- Create: `.claude/settings.json`
- Create: `.claude/agents/security-reviewer.md`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `.githooks/post-checkout`
- Create: `scripts/setup-env.sh`
- Create: `LICENSE`
- Create: `README.md`
- Create: `.github/pull_request_template.md`
- Create: `.github/CODEOWNERS`
- Create: `www/.gitkeep`

**Step 1: Create CLAUDE.md (minimal, points to AGENTS.md)**

```markdown
---
desc: See AGENTS.md for full project guidelines and agent instructions.
---

@AGENTS.md
```

**Step 2: Create AGENTS.md**

```markdown
# Mcode

Performant AI agent orchestration desktop app built with Rust + Tauri.

## Directory Structure

```
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
- **Testing:** `cargo test` (Rust), Vitest (frontend)

## Commit Guidelines

Use [Conventional Commits](https://www.conventionalcommits.org/).
Types: feat, fix, refactor, docs, test, chore, perf, ci

Keep commits atomic. Each commit represents one logical change.

## Key Documentation

- **Design doc:** `docs/plans/2026-03-22-mcode-design.md`
- **Implementation plan:** `docs/plans/2026-03-22-mcode-implementation-plan.md`
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
```

**Step 3: Create .claude/settings.json**

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "bash -c 'if echo \"$TOOL_INPUT\" | grep -qE \"\\.env$\"; then echo \"BLOCK: Do not edit .env files directly. Update .env.example instead.\"; exit 2; fi'"
          }
        ]
      }
    ]
  }
}
```

**Step 4: Create .claude/agents/security-reviewer.md**

```markdown
---
name: security-reviewer
description: Security review specialist for Mcode
model: sonnet
---

You are a security reviewer for Mcode, a Tauri desktop app.

## Focus Areas

### Tauri Security
- Verify capability scopes are minimal (shell only allows claude and git)
- Check CSP headers in tauri.conf.json
- Ensure no arbitrary command execution paths
- Validate file system access is scoped

### Process Management
- Child process spawning must use allowlisted binaries only
- No shell injection via user-provided workspace paths
- Process cleanup on shutdown (no orphaned processes)

### Data Security
- SQLite database contains conversation history (sensitive)
- No secrets stored in database
- Log files must not contain sensitive data
- Environment variables handled safely

### Frontend Security
- No XSS via rendered markdown (sanitize agent output)
- No eval() or dynamic script execution
- CSP enforced in Tauri webview

## Review Checklist
- [ ] Shell commands use scoped permissions only
- [ ] User input sanitized before use in process args
- [ ] SQLite queries use parameterized statements
- [ ] No hardcoded secrets
- [ ] Error messages don't leak file paths or system info
- [ ] Markdown rendering sanitizes HTML
```

**Step 5: Create remaining config files**

`.gitignore`:
```
# Rust
target/
Cargo.lock
!Cargo.lock

# Frontend
frontend/node_modules/
frontend/dist/

# Tauri
src-tauri/target/

# Environment
.env
.env.local
.env.*.local

# IDE
.idea/
.vscode/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db

# Mcode data
.mcode/

# Worktrees
.worktrees/

# Logs
*.log
```

`.env.example`:
```bash
# Mcode Development Environment
# Copy to .env and fill in values

# Optional: Override Claude CLI path (defaults to 'claude' on PATH)
# MCODE_CLAUDE_PATH=claude

# Optional: Override git path (defaults to 'git' on PATH)
# MCODE_GIT_PATH=git

# Optional: Log level (error, warn, info, debug, trace)
RUST_LOG=info
```

`.githooks/post-checkout`:
```bash
#!/bin/bash
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example - fill in your values"
fi
```

`scripts/setup-env.sh`:
```bash
#!/bin/bash
set -e

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example"
else
  echo ".env already exists"
fi

echo "Setting git hooks path..."
git config core.hooksPath .githooks
echo "Done."
```

`.github/pull_request_template.md`:
```markdown
## What
<!-- Brief description of the change -->

## Why
<!-- Motivation and context -->

## Key Changes
-

## Config Changes
<!-- If any env vars, settings, or secrets were added/changed/removed -->
None
```

`.github/CODEOWNERS`:
```
* @chuks-qua
```

`LICENSE`: MIT license with "Mzeey Empire" as copyright holder, year 2026.

`README.md`:
```markdown
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
cd frontend && npm install && cd ..

# Run in dev mode
cargo tauri dev
```

## Architecture

See [Design Document](docs/plans/2026-03-22-mcode-design.md).

## License

MIT
```

`www/.gitkeep`: empty file

**Step 6: Commit**

```bash
git add CLAUDE.md AGENTS.md .claude/ .gitignore .env.example .githooks/ scripts/ .github/ LICENSE README.md www/
git commit -m "chore: add project configuration, AGENTS.md, CI templates, and README"
```

---

### Task 6: CI/CD workflows

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release-please.yml`
- Create: `.github/workflows/build-release.yml`
- Create: `release-please-config.json`
- Create: `.release-please-manifest.json`
- Create: `CHANGELOG.md`

**Step 1: Create CI workflow**

```yaml
# .github/workflows/ci.yml
name: CI

on:
  pull_request:
    branches: [main]

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  pr-title:
    name: PR Title
    runs-on: ubuntu-latest
    steps:
      - uses: amannn/action-semantic-pull-request@v5
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

  lint-rust:
    name: Lint Rust
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          components: rustfmt, clippy
      - uses: Swatinem/rust-cache@v2
      - run: cargo fmt --all -- --check
      - run: cargo clippy --all-targets --all-features -- -D warnings

  test-rust:
    name: Test Rust
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - uses: Swatinem/rust-cache@v2
      - run: cargo test --all

  lint-frontend:
    name: Lint Frontend
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: frontend
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: frontend/package-lock.json
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck

  test-frontend:
    name: Test Frontend
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: frontend
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: frontend/package-lock.json
      - run: npm ci
      - run: npx vitest run

  build-check:
    name: Build Check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - uses: Swatinem/rust-cache@v2
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: frontend/package-lock.json
      - run: cd frontend && npm ci && npm run build
      - run: sudo apt-get update && sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev
      - run: cargo build
```

**Step 2: Create release-please workflow**

```yaml
# .github/workflows/release-please.yml
name: Release Please

on:
  push:
    branches: [main]

permissions:
  contents: write
  pull-requests: write

jobs:
  release-please:
    runs-on: ubuntu-latest
    outputs:
      releases_created: ${{ steps.release.outputs.releases_created }}
      tag_name: ${{ steps.release.outputs['src-tauri--tag_name'] }}
      version: ${{ steps.release.outputs['src-tauri--version'] }}
    steps:
      - uses: googleapis/release-please-action@v4
        id: release
        with:
          config-file: release-please-config.json
          manifest-file: .release-please-manifest.json
```

**Step 3: Create build-release workflow**

```yaml
# .github/workflows/build-release.yml
name: Build Release

on:
  release:
    types: [published]

jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        include:
          - platform: windows-latest
            target: x86_64-pc-windows-msvc
          - platform: macos-latest
            target: aarch64-apple-darwin
          - platform: macos-latest
            target: x86_64-apple-darwin
          - platform: ubuntu-22.04
            target: x86_64-unknown-linux-gnu

    runs-on: ${{ matrix.platform }}
    steps:
      - uses: actions/checkout@v4

      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.target }}

      - uses: Swatinem/rust-cache@v2

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: frontend/package-lock.json

      - name: Install frontend deps
        run: cd frontend && npm ci

      - name: Install Linux deps
        if: matrix.platform == 'ubuntu-22.04'
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev

      - name: Build Tauri
        uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          tagName: ${{ github.ref_name }}
          releaseName: "Mcode ${{ github.ref_name }}"
          args: --target ${{ matrix.target }}
```

**Step 4: Create release-please config**

```json
// release-please-config.json
{
  "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
  "separate-pull-requests": false,
  "bump-minor-pre-major": true,
  "bump-patch-for-minor-pre-major": true,
  "changelog-sections": [
    { "type": "feat", "section": "Features", "hidden": false },
    { "type": "fix", "section": "Bug Fixes", "hidden": false },
    { "type": "perf", "section": "Performance Improvements", "hidden": false },
    { "type": "refactor", "section": "Code Refactoring", "hidden": false },
    { "type": "docs", "section": "Documentation", "hidden": true },
    { "type": "chore", "section": "Miscellaneous", "hidden": true },
    { "type": "test", "section": "Tests", "hidden": true },
    { "type": "ci", "section": "CI", "hidden": true }
  ],
  "plugins": [
    { "type": "cargo-workspace" }
  ],
  "packages": {
    "crates/mcode-core": {
      "release-type": "rust",
      "component": "mcode-core"
    },
    "crates/mcode-api": {
      "release-type": "rust",
      "component": "mcode-api"
    },
    "src-tauri": {
      "release-type": "rust",
      "component": "mcode-desktop",
      "extra-files": [
        {
          "type": "json",
          "path": "tauri.conf.json",
          "jsonpath": "$.version"
        }
      ]
    },
    "frontend": {
      "release-type": "node",
      "component": "mcode-frontend"
    }
  }
}
```

```json
// .release-please-manifest.json
{
  "crates/mcode-core": "0.1.0",
  "crates/mcode-api": "0.1.0",
  "src-tauri": "0.1.0",
  "frontend": "0.1.0"
}
```

`CHANGELOG.md`:
```markdown
# Changelog
```

**Step 5: Commit**

```bash
git add .github/workflows/ release-please-config.json .release-please-manifest.json CHANGELOG.md
git commit -m "ci: add CI, release-please, and cross-platform build workflows"
```

---

## Phase 2: Core Data Layer (mcode-core)

SQLite store, models, migrations, and the single-writer pattern.

---

### Task 7: SQLite store with migrations

**Files:**
- Create: `crates/mcode-core/src/store/mod.rs`
- Create: `crates/mcode-core/src/store/models.rs`
- Create: `crates/mcode-core/src/store/migrations/V001__initial_schema.sql`
- Create: `crates/mcode-core/src/store/writer.rs`
- Modify: `crates/mcode-core/src/lib.rs`

**Step 1: Write tests for the store models**

```rust
// crates/mcode-core/src/store/models.rs
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ThreadStatus {
    Active,
    Paused,
    Interrupted,
    Errored,
    Archived,
    Completed,
    Deleted,
}

impl ThreadStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Paused => "paused",
            Self::Interrupted => "interrupted",
            Self::Errored => "errored",
            Self::Archived => "archived",
            Self::Completed => "completed",
            Self::Deleted => "deleted",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "active" => Some(Self::Active),
            "paused" => Some(Self::Paused),
            "interrupted" => Some(Self::Interrupted),
            "errored" => Some(Self::Errored),
            "archived" => Some(Self::Archived),
            "completed" => Some(Self::Completed),
            "deleted" => Some(Self::Deleted),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ThreadMode {
    Direct,
    Worktree,
}

impl ThreadMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Direct => "direct",
            Self::Worktree => "worktree",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "direct" => Some(Self::Direct),
            "worktree" => Some(Self::Worktree),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum MessageRole {
    User,
    Assistant,
    System,
}

impl MessageRole {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
            Self::System => "system",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "user" => Some(Self::User),
            "assistant" => Some(Self::Assistant),
            "system" => Some(Self::System),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: Uuid,
    pub name: String,
    pub path: String,
    pub provider_config: serde_json::Value,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Thread {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub title: String,
    pub status: ThreadStatus,
    pub mode: ThreadMode,
    pub worktree_path: Option<String>,
    pub branch: String,
    pub issue_number: Option<i64>,
    pub pr_number: Option<i64>,
    pub pr_status: Option<String>,
    pub session_name: String,
    pub pid: Option<i64>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub deleted_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: Uuid,
    pub thread_id: Uuid,
    pub role: MessageRole,
    pub content: String,
    pub tool_calls: Option<serde_json::Value>,
    pub files_changed: Option<serde_json::Value>,
    pub cost_usd: Option<f64>,
    pub tokens_used: Option<i64>,
    pub timestamp: DateTime<Utc>,
    pub sequence: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thread_status_roundtrip() {
        let statuses = vec![
            ThreadStatus::Active,
            ThreadStatus::Paused,
            ThreadStatus::Interrupted,
            ThreadStatus::Errored,
            ThreadStatus::Archived,
            ThreadStatus::Completed,
            ThreadStatus::Deleted,
        ];
        for status in statuses {
            let s = status.as_str();
            let parsed = ThreadStatus::from_str(s).unwrap();
            assert_eq!(status, parsed);
        }
    }

    #[test]
    fn thread_mode_roundtrip() {
        assert_eq!(ThreadMode::from_str("direct"), Some(ThreadMode::Direct));
        assert_eq!(ThreadMode::from_str("worktree"), Some(ThreadMode::Worktree));
        assert_eq!(ThreadMode::from_str("invalid"), None);
    }

    #[test]
    fn message_role_roundtrip() {
        assert_eq!(MessageRole::from_str("user"), Some(MessageRole::User));
        assert_eq!(MessageRole::from_str("assistant"), Some(MessageRole::Assistant));
        assert_eq!(MessageRole::from_str("system"), Some(MessageRole::System));
        assert_eq!(MessageRole::from_str("invalid"), None);
    }
}
```

**Step 2: Run tests to verify they pass**

Run: `cargo test -p mcode-core`
Expected: All model tests pass.

**Step 3: Create the initial migration**

```sql
-- crates/mcode-core/src/store/migrations/V001__initial_schema.sql

CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    provider_config TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    mode TEXT NOT NULL DEFAULT 'direct',
    worktree_path TEXT,
    branch TEXT NOT NULL,
    issue_number INTEGER,
    pr_number INTEGER,
    pr_status TEXT,
    session_name TEXT NOT NULL,
    pid INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    deleted_at TEXT
);

CREATE INDEX idx_threads_workspace ON threads(workspace_id);
CREATE INDEX idx_threads_status ON threads(status);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY NOT NULL,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    tool_calls TEXT,
    files_changed TEXT,
    cost_usd REAL,
    tokens_used INTEGER,
    timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    sequence INTEGER NOT NULL
);

CREATE INDEX idx_messages_thread ON messages(thread_id);
CREATE INDEX idx_messages_sequence ON messages(thread_id, sequence);
```

**Step 4: Create the store module with single-writer pattern**

```rust
// crates/mcode-core/src/store/writer.rs
use anyhow::Result;
use rusqlite::Connection;
use tokio::sync::{mpsc, oneshot};
use tracing::{error, info};

pub type DbResult<T> = Result<T, anyhow::Error>;

pub enum DbCommand {
    Execute {
        sql: String,
        params: Vec<String>,
        reply: oneshot::Sender<DbResult<usize>>,
    },
    Query {
        sql: String,
        params: Vec<String>,
        reply: oneshot::Sender<DbResult<Vec<Vec<String>>>>,
    },
    Shutdown,
}

pub struct DbWriter {
    sender: mpsc::Sender<DbCommand>,
}

impl DbWriter {
    pub fn new(db_path: &str) -> Result<Self> {
        let db_path = db_path.to_string();
        let (tx, mut rx) = mpsc::channel::<DbCommand>(256);

        std::thread::spawn(move || {
            let conn = match Connection::open(&db_path) {
                Ok(c) => c,
                Err(e) => {
                    error!("Failed to open database: {}", e);
                    return;
                }
            };

            conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
                .expect("Failed to set pragmas");

            info!("Database writer started: {}", db_path);

            while let Some(cmd) = rx.blocking_recv() {
                match cmd {
                    DbCommand::Shutdown => break,
                    DbCommand::Execute { sql, params, reply } => {
                        let result = conn.execute(
                            &sql,
                            rusqlite::params_from_iter(params.iter()),
                        ).map_err(|e| anyhow::anyhow!(e));
                        let _ = reply.send(result);
                    }
                    DbCommand::Query { sql, params, reply } => {
                        let result = (|| -> DbResult<Vec<Vec<String>>> {
                            let mut stmt = conn.prepare(&sql)?;
                            let col_count = stmt.column_count();
                            let rows = stmt.query_map(
                                rusqlite::params_from_iter(params.iter()),
                                |row| {
                                    let mut cols = Vec::with_capacity(col_count);
                                    for i in 0..col_count {
                                        cols.push(row.get::<_, String>(i).unwrap_or_default());
                                    }
                                    Ok(cols)
                                },
                            )?;
                            let mut results = Vec::new();
                            for row in rows {
                                results.push(row?);
                            }
                            Ok(results)
                        })();
                        let _ = reply.send(result);
                    }
                }
            }

            info!("Database writer shut down");
        });

        Ok(Self { sender: tx })
    }

    pub fn sender(&self) -> mpsc::Sender<DbCommand> {
        self.sender.clone()
    }
}
```

```rust
// crates/mcode-core/src/store/mod.rs
pub mod models;
pub mod writer;

use anyhow::Result;
use refinery::embed_migrations;
use rusqlite::Connection;
use tracing::info;

embed_migrations!("src/store/migrations");

pub fn run_migrations(db_path: &str) -> Result<()> {
    let mut conn = Connection::open(db_path)?;
    info!("Running database migrations...");
    migrations::runner().run(&mut conn)?;
    info!("Migrations complete");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_run_on_memory_db() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::runner().run(&mut conn).unwrap();

        // Verify tables exist
        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();

        assert!(tables.contains(&"workspaces".to_string()));
        assert!(tables.contains(&"threads".to_string()));
        assert!(tables.contains(&"messages".to_string()));
    }
}
```

**Step 5: Update lib.rs to export store module**

```rust
// crates/mcode-core/src/lib.rs
pub mod events;
pub mod store;

pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_is_set() {
        assert!(!version().is_empty());
    }
}
```

**Step 6: Run all tests**

Run: `cargo test -p mcode-core`
Expected: All tests pass including migration test.

**Step 7: Commit**

```bash
git add crates/mcode-core/src/store/
git commit -m "feat: add SQLite store with models, migrations, and single-writer pattern"
```

---

## Phase 3: Process Management

### Task 8: Stream-JSON parser

**Files:**
- Create: `crates/mcode-core/src/process/mod.rs`
- Create: `crates/mcode-core/src/process/stream.rs`

Parses Claude CLI's `--output-format stream-json` output into typed events.

**Step 1: Write tests for stream parser**

```rust
// crates/mcode-core/src/process/stream.rs
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum StreamEvent {
    #[serde(rename = "system")]
    System { subtype: String, data: Option<Value> },
    #[serde(rename = "assistant")]
    Assistant { message: AssistantMessage },
    #[serde(rename = "content_block_start")]
    ContentBlockStart { index: usize, content_block: ContentBlock },
    #[serde(rename = "content_block_delta")]
    ContentBlockDelta { index: usize, delta: Delta },
    #[serde(rename = "content_block_stop")]
    ContentBlockStop { index: usize },
    #[serde(rename = "result")]
    Result { result: ResultData },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssistantMessage {
    pub role: Option<String>,
    pub content: Option<Vec<Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ContentBlock {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "tool_use")]
    ToolUse { id: String, name: String, input: Value },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Delta {
    #[serde(rename = "text_delta")]
    TextDelta { text: String },
    #[serde(rename = "input_json_delta")]
    InputJsonDelta { partial_json: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResultData {
    pub cost_usd: Option<f64>,
    pub tokens_used: Option<i64>,
    pub is_error: Option<bool>,
}

pub fn parse_stream_line(line: &str) -> Option<StreamEvent> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    serde_json::from_str(trimmed).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_system_event() {
        let line = r#"{"type":"system","subtype":"init","data":{"session_id":"abc"}}"#;
        let event = parse_stream_line(line).unwrap();
        match event {
            StreamEvent::System { subtype, .. } => assert_eq!(subtype, "init"),
            _ => panic!("Expected System event"),
        }
    }

    #[test]
    fn parse_text_delta() {
        let line = r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}"#;
        let event = parse_stream_line(line).unwrap();
        match event {
            StreamEvent::ContentBlockDelta { delta: Delta::TextDelta { text }, .. } => {
                assert_eq!(text, "Hello");
            }
            _ => panic!("Expected ContentBlockDelta"),
        }
    }

    #[test]
    fn parse_result() {
        let line = r#"{"type":"result","result":{"cost_usd":0.05,"tokens_used":1500,"is_error":false}}"#;
        let event = parse_stream_line(line).unwrap();
        match event {
            StreamEvent::Result { result } => {
                assert_eq!(result.cost_usd, Some(0.05));
                assert_eq!(result.tokens_used, Some(1500));
            }
            _ => panic!("Expected Result event"),
        }
    }

    #[test]
    fn parse_empty_line_returns_none() {
        assert!(parse_stream_line("").is_none());
        assert!(parse_stream_line("   ").is_none());
    }

    #[test]
    fn parse_invalid_json_returns_none() {
        assert!(parse_stream_line("not json").is_none());
    }
}
```

```rust
// crates/mcode-core/src/process/mod.rs
pub mod stream;
```

**Step 2: Update lib.rs**

Add `pub mod process;` to `crates/mcode-core/src/lib.rs`.

**Step 3: Run tests**

Run: `cargo test -p mcode-core`
Expected: All stream parser tests pass.

**Step 4: Commit**

```bash
git add crates/mcode-core/src/process/
git commit -m "feat: add stream-json parser for Claude CLI output"
```

---

### Task 9: Process manager (spawn, stream, terminate)

**Files:**
- Create: `crates/mcode-core/src/process/manager.rs`
- Create: `crates/mcode-core/src/process/provider.rs`

**Step 1: Define the provider trait and Claude implementation**

```rust
// crates/mcode-core/src/process/provider.rs
use anyhow::Result;
use std::process::ExitStatus;
use tokio::io::AsyncBufReadExt;
use tokio::process::{Child, Command};
use tokio::sync::mpsc;
use tracing::{debug, error, info};

use super::stream::{parse_stream_line, StreamEvent};

pub struct SpawnConfig {
    pub session_name: String,
    pub prompt: String,
    pub cwd: String,
    pub resume: bool,
}

pub struct ClaudeProvider;

impl ClaudeProvider {
    pub fn spawn(config: SpawnConfig) -> Result<AgentHandle> {
        let mut cmd = Command::new("claude");
        cmd.current_dir(&config.cwd);
        cmd.arg("--output-format").arg("stream-json");
        cmd.arg("--verbose");
        cmd.arg("--session-name").arg(&config.session_name);

        if config.resume {
            cmd.arg("--resume").arg(&config.session_name);
        }

        cmd.arg("-p").arg(&config.prompt);

        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());

        info!(
            session = %config.session_name,
            cwd = %config.cwd,
            resume = config.resume,
            "Spawning Claude CLI"
        );

        let mut child = cmd.spawn()?;
        let pid = child.id().unwrap_or(0);
        let stdout = child.stdout.take().expect("stdout must be piped");

        let (event_tx, event_rx) = mpsc::channel::<StreamEvent>(512);

        // Spawn reader task
        tokio::spawn(async move {
            let reader = tokio::io::BufReader::new(stdout);
            let mut lines = reader.lines();

            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(event) = parse_stream_line(&line) {
                    if event_tx.send(event).await.is_err() {
                        debug!("Event receiver dropped, stopping stream reader");
                        break;
                    }
                }
            }
        });

        Ok(AgentHandle {
            child,
            pid,
            events: event_rx,
        })
    }
}

pub struct AgentHandle {
    child: Child,
    pub pid: u32,
    pub events: mpsc::Receiver<StreamEvent>,
}

impl AgentHandle {
    pub async fn terminate(&mut self) -> Result<ExitStatus> {
        info!(pid = self.pid, "Terminating agent process");
        self.child.kill().await?;
        let status = self.child.wait().await?;
        Ok(status)
    }

    pub async fn wait(&mut self) -> Result<ExitStatus> {
        let status = self.child.wait().await?;
        Ok(status)
    }
}
```

**Step 2: Create process manager**

```rust
// crates/mcode-core/src/process/manager.rs
use anyhow::Result;
use std::collections::HashMap;
use tokio::sync::Mutex;
use tracing::{info, warn};
use uuid::Uuid;

use super::provider::{AgentHandle, ClaudeProvider, SpawnConfig};

pub struct ProcessManager {
    processes: Mutex<HashMap<Uuid, AgentHandle>>,
    max_concurrent: usize,
}

impl ProcessManager {
    pub fn new(max_concurrent: usize) -> Self {
        Self {
            processes: Mutex::new(HashMap::new()),
            max_concurrent,
        }
    }

    pub async fn spawn(&self, thread_id: Uuid, config: SpawnConfig) -> Result<u32> {
        let mut procs = self.processes.lock().await;

        if procs.len() >= self.max_concurrent {
            anyhow::bail!(
                "Max concurrent agents ({}) reached. Stop an agent before starting a new one.",
                self.max_concurrent
            );
        }

        let handle = ClaudeProvider::spawn(config)?;
        let pid = handle.pid;
        procs.insert(thread_id, handle);

        info!(thread_id = %thread_id, pid = pid, "Agent spawned");
        Ok(pid)
    }

    pub async fn terminate(&self, thread_id: &Uuid) -> Result<()> {
        let mut procs = self.processes.lock().await;
        if let Some(mut handle) = procs.remove(thread_id) {
            handle.terminate().await?;
            info!(thread_id = %thread_id, "Agent terminated");
        } else {
            warn!(thread_id = %thread_id, "No running agent found");
        }
        Ok(())
    }

    pub async fn terminate_all(&self) -> Vec<Uuid> {
        let mut procs = self.processes.lock().await;
        let mut terminated = Vec::new();

        for (id, mut handle) in procs.drain() {
            if let Err(e) = handle.terminate().await {
                warn!(thread_id = %id, error = %e, "Failed to terminate agent");
            }
            terminated.push(id);
        }

        info!(count = terminated.len(), "All agents terminated");
        terminated
    }

    pub async fn active_count(&self) -> usize {
        self.processes.lock().await.len()
    }

    pub async fn is_running(&self, thread_id: &Uuid) -> bool {
        self.processes.lock().await.contains_key(thread_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn respects_max_concurrent() {
        let manager = ProcessManager::new(2);
        assert_eq!(manager.active_count().await, 0);
        // We can't spawn real claude processes in tests,
        // but we verify the manager initializes correctly
        assert_eq!(manager.max_concurrent, 2);
    }
}
```

**Step 3: Update mod.rs**

```rust
// crates/mcode-core/src/process/mod.rs
pub mod manager;
pub mod provider;
pub mod stream;
```

**Step 4: Run tests**

Run: `cargo test -p mcode-core`
Expected: All tests pass.

**Step 5: Commit**

```bash
git add crates/mcode-core/src/process/
git commit -m "feat: add process manager with Claude CLI provider and concurrency limits"
```

---

### Task 10: Workspace and thread management

**Files:**
- Create: `crates/mcode-core/src/workspace/mod.rs`
- Create: `crates/mcode-core/src/workspace/workspace.rs`
- Create: `crates/mcode-core/src/workspace/thread.rs`

This task creates the CRUD operations for workspaces and threads against SQLite. Tests use an in-memory database.

Follows the same TDD pattern as previous tasks. Write tests first, implement, verify, commit.

```bash
git commit -m "feat: add workspace and thread CRUD operations"
```

---

### Task 11: Git worktree manager

**Files:**
- Create: `crates/mcode-core/src/worktree/mod.rs`

Create/remove git worktrees using the `git2` crate. Tests use a temporary git repo.

```bash
git commit -m "feat: add git worktree manager using git2"
```

---

### Task 12: Config discovery module

**Files:**
- Create: `crates/mcode-core/src/config/mod.rs`
- Create: `crates/mcode-core/src/config/claude.rs`

Read-only module that discovers `~/.claude/` config, resolves paths, and builds CLI args. Does NOT write to Claude's config.

```bash
git commit -m "feat: add Claude config discovery module"
```

---

## Phase 4: API Layer and Tauri Wiring

### Task 13: Wire mcode-api commands

**Files:**
- Modify: `crates/mcode-api/src/lib.rs`
- Create: `crates/mcode-api/src/commands.rs`
- Create: `crates/mcode-api/src/events.rs`
- Create: `crates/mcode-api/src/queries.rs`

Expose mcode-core functionality through a clean command/query/event interface.

```bash
git commit -m "feat: add mcode-api command, query, and event interfaces"
```

---

### Task 14: Tauri commands and event streaming

**Files:**
- Modify: `src-tauri/src/lib.rs`

Wire mcode-api commands to Tauri `#[tauri::command]` functions. Set up event streaming via Tauri's Channel API.

```bash
git commit -m "feat: wire Tauri commands to mcode-api with event streaming"
```

---

### Task 15: Graceful shutdown handler

**Files:**
- Modify: `src-tauri/src/lib.rs`

Handle `CloseRequested` window event. Show dialog if agents running, terminate processes, persist interrupted state.

```bash
git commit -m "feat: add graceful shutdown with agent status dialog"
```

---

## Phase 5: Frontend UI

### Task 16: Transport adapter layer

**Files:**
- Create: `frontend/src/transport/index.ts`
- Create: `frontend/src/transport/tauri.ts`
- Create: `frontend/src/transport/types.ts`

```bash
git commit -m "feat: add transport adapter layer for Tauri IPC"
```

---

### Task 17: Zustand stores

**Files:**
- Create: `frontend/src/stores/workspaceStore.ts`
- Create: `frontend/src/stores/threadStore.ts`
- Create: `frontend/src/stores/settingsStore.ts`

```bash
git commit -m "feat: add Zustand stores for workspace, thread, and settings state"
```

---

### Task 18: Sidebar (workspace and thread list)

**Files:**
- Create: `frontend/src/components/sidebar/WorkspaceList.tsx`
- Create: `frontend/src/components/sidebar/ThreadList.tsx`
- Create: `frontend/src/components/sidebar/ThreadItem.tsx`
- Create: `frontend/src/components/sidebar/Sidebar.tsx`

T3Code-inspired sidebar with workspace sections, thread list with status icons, branch names, and PR badges.

```bash
git commit -m "feat: add sidebar with workspace and thread navigation"
```

---

### Task 19: Chat view (message list, composer, streaming)

**Files:**
- Create: `frontend/src/components/chat/MessageList.tsx`
- Create: `frontend/src/components/chat/MessageBubble.tsx`
- Create: `frontend/src/components/chat/ToolCallBlock.tsx`
- Create: `frontend/src/components/chat/Composer.tsx`
- Create: `frontend/src/components/chat/StreamingIndicator.tsx`
- Create: `frontend/src/components/chat/ChatView.tsx`

Virtualized message list, markdown rendering, collapsible tool calls, composer with Ctrl+Enter send.

```bash
git commit -m "feat: add chat view with virtualized messages and streaming"
```

---

### Task 20: Routing and layout

**Files:**
- Create: `frontend/src/app/routes/index.tsx`
- Create: `frontend/src/app/routes/workspace.$id.tsx`
- Create: `frontend/src/app/routes/workspace.$id.thread.$tid.tsx`
- Modify: `frontend/src/app/App.tsx`

Wire TanStack Router with sidebar + chat layout.

```bash
git commit -m "feat: add file-based routing with workspace and thread views"
```

---

### Task 21: Keyboard shortcuts

**Files:**
- Create: `frontend/src/lib/shortcuts.ts`
- Modify: `frontend/src/app/App.tsx`

Centralized shortcut registry: Ctrl+N, Ctrl+K, Ctrl+Enter, Ctrl+[1-9], Escape.

```bash
git commit -m "feat: add centralized keyboard shortcut registry"
```

---

### Task 22: Theme and settings UI

**Files:**
- Create: `frontend/src/components/settings/SettingsDialog.tsx`
- Modify: `frontend/src/app/providers.tsx`

Dark/light theme toggle, max concurrent agents setting, notification toggle.

```bash
git commit -m "feat: add settings dialog with theme and notification preferences"
```

---

## Phase 6: Integration and Polish

### Task 23: End-to-end integration test

Verify the full flow: open workspace, create thread, send message, see streaming output, stop agent. Manual test since it requires Claude CLI.

```bash
git commit -m "test: add integration test harness for full agent workflow"
```

---

### Task 24: Logging and debug tools

**Files:**
- Modify: `src-tauri/src/lib.rs` (tracing setup with rotating file logs)
- Create: `frontend/src/components/settings/DebugLogs.tsx` (copy logs button)

```bash
git commit -m "feat: add rotating file logs and debug log copy button"
```

---

### Task 25: Push to GitHub and verify CI

**Step 1:** Push all commits to a feature branch
**Step 2:** Open PR, verify all CI checks pass
**Step 3:** Squash merge to main
**Step 4:** Verify release-please creates a release PR

```bash
git push -u origin main
```

---

## Execution Order Summary

| Phase | Tasks | Focus |
|-------|-------|-------|
| 1. Scaffolding | 1-6 | Repo, Cargo workspace, Tauri, React, config, CI |
| 2. Core Data | 7 | SQLite store, models, migrations |
| 3. Process Mgmt | 8-12 | Stream parser, process manager, worktree, config |
| 4. API + Tauri | 13-15 | mcode-api, Tauri commands, shutdown |
| 5. Frontend UI | 16-22 | Transport, stores, sidebar, chat, routing, shortcuts |
| 6. Integration | 23-25 | E2E test, logging, CI verification |

**Estimated commits:** 25
**Dependencies:** Tasks within each phase are sequential. Phases are sequential (each builds on the previous).
