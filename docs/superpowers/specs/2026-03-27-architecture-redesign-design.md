# Architecture Redesign: Server Extraction and Clean Layering

**Date:** 2026-03-27
**Status:** Proposed
**Scope:** Full architectural restructure of mcode from embedded Electron server to separated server process with WebSocket communication

## Executive Summary

Extract all business logic from the Electron main process into a standalone Node.js server process. The server communicates with the React frontend via WebSocket. The Electron desktop app becomes a thin shell (~500 lines) that spawns the server and bridges native OS features. A shared contracts package eliminates type duplication. A provider registry with tsyringe DI enables clean multi-provider support for AI agents.

## Motivation

The current architecture embeds the server (business logic, DB, sidecar, git, PTY) inside Electron's main process. This causes:

- **No separation of concerns**: `app-state.ts` (656 lines) mixes orchestration, attachment handling, file I/O, and session tracking. `index.ts` (750 lines) mixes IPC routing, event forwarding, DB persistence, and lifecycle management.
- **Type duplication**: `Workspace`, `Thread`, `Message` are manually duplicated between `apps/desktop/src/main/models.ts` and `apps/web/src/transport/types.ts`, already out of sync (missing `worktree_managed`, `sdk_session_id`).
- **No provider abstraction**: The Claude Agent SDK is hardcoded in `sidecar/client.ts`. No interface for swapping or adding providers (Codex, Gemini, Copilot).
- **Dead code**: Tauri transport (20/27 methods throw "Not implemented"), legacy CLI event handlers, `session.delta` event type (defined but never emitted), `bridge.crashed` handler, `pid` and `session_name` fields (never written).
- **Stale caching**: File list cache never invalidates during active sessions. `git ls-files` misses untracked files.
- **Locked to Electron**: Cannot run the server standalone or in a browser.

## Architecture Overview

```
packages/
  contracts/                    Single source of truth for all types
  shared/                       Runtime utilities shared across packages

apps/
  server/                       Standalone Node.js HTTP + WebSocket server
  web/                          React SPA (connects via WebSocket)
  desktop/                      Thin Electron shell (~500 lines)
```

### Package Dependency Graph

```
contracts (zero runtime deps)
    |
    +--> shared (depends on contracts)
    |       |
    |       +--> server (depends on contracts + shared)
    |       +--> desktop (depends on contracts + shared)
    |
    +--> web (depends on contracts only)
```

### Communication Flow

```
Desktop (Electron main process)
  |
  |-- spawns server as Node.js child process
  |     |
  |     |-- HTTP server (attachment serving, health check)
  |     |-- WebSocket server (all business logic RPC + push events)
  |     |-- SQLite database, AI providers, git, PTY, file ops
  |
  |-- BrowserWindow loads web app
        |
        |-- WebSocket connection to server (all business logic)
        |-- desktopBridge (Electron IPC) for native-only features
```

### Key Rules

- `server` has zero Electron imports. Pure Node.js.
- `desktop` has zero business logic. Cannot read the DB or manage agents.
- `web` never imports from `server` or `desktop`. Only from `contracts` and `shared`.
- `contracts` has zero runtime dependencies. Types and Zod schemas only.

---

## Section 1: Package Structure

### packages/contracts

Single source of truth for all shared types, replacing the manual duplication between desktop and web.

```
packages/contracts/
  package.json                  @mcode/contracts, private, JIT (raw .ts exports)
  src/
    index.ts                    Barrel re-export
    models/
      workspace.ts              Workspace schema + type
      thread.ts                 Thread schema + type (includes worktree_managed, sdk_session_id)
      message.ts                Message schema + type
      attachment.ts             AttachmentMeta, StoredAttachment
      enums.ts                  ThreadStatus, ThreadMode, MessageRole, PermissionMode, InteractionMode
    events/
      agent-event.ts            AgentEvent discriminated union (Zod)
    ws/
      methods.ts                WS_METHODS: RPC method definitions (params + result schemas)
      channels.ts               WS_CHANNELS: push channel definitions
      protocol.ts               WebSocketRequest, WebSocketResponse, WsPush types
    providers/
      interfaces.ts             IAgentProvider, IProviderRegistry, ProviderId
    git.ts                      GitBranch, WorktreeInfo schemas
    github.ts                   PrInfo, PrDetail schemas
    skills.ts                   SkillInfo schema
```

Uses Zod for schemas that serve as both TypeScript types (via `z.infer`) and runtime validators at the WebSocket boundary.

### packages/shared

Runtime utilities used by multiple packages.

```
packages/shared/
  src/
    logging/                    Rotating file logger (Winston + daily rotation)
    paths/                      Mcode data directory resolution (from MCODE_DATA_DIR env)
    git/                        Branch name sanitization, validation helpers
```

### apps/server

Standalone Node.js process. Owns all business logic.

```
apps/server/
  src/
    index.ts                    HTTP + WebSocket server entry point
    container.ts                tsyringe composition root
    services/
      agent-service.ts          Orchestrates agent sessions, event forwarding
      workspace-service.ts      Workspace CRUD
      thread-service.ts         Thread lifecycle, worktree provisioning
      git-service.ts            Branch, worktree, checkout, fetch operations
      github-service.ts         PR operations via gh CLI
      file-service.ts           File listing (git ls-files), reading
      config-service.ts         Claude config discovery
      skill-service.ts          Skill scanning from filesystem
      terminal-service.ts       PTY management (node-pty)
      attachment-service.ts     Persist/read attachments
    providers/
      interfaces.ts             Re-exports from contracts for convenience
      provider-registry.ts      Resolves provider by ID, injects all registered providers
      claude/
        claude-provider.ts      Claude Agent SDK adapter (prompt queue pattern)
    repositories/
      workspace-repo.ts         Workspace data access
      thread-repo.ts            Thread data access
      message-repo.ts           Message data access
    store/
      database.ts               SQLite setup, migrations
    transport/
      ws-server.ts              WebSocket server, auth, RPC routing
      ws-router.ts              Method string to service dispatch
      push.ts                   Broadcast push events to connected clients
```

### apps/web

React SPA. Mostly unchanged. Only the transport layer swaps.

```
apps/web/
  src/
    transport/
      index.ts                  Factory: WS transport (Electron or standalone)
      ws-transport.ts           NEW: WebSocket RPC client + push event emitter
      ws-events.ts              NEW: Push channel listener setup
      desktop-bridge.d.ts       NEW: Type declarations for window.desktopBridge
      (electron.ts              DELETED)
      (tauri.ts                 DELETED)
      (events.ts                DELETED)
      (electron-api.d.ts        DELETED)
    (stores/, components/, lib/ largely unchanged)
```

### apps/desktop

Thin Electron shell. ~500 lines across 3 files.

```
apps/desktop/
  src/
    main.ts                     Window creation, server spawn, native IPC handlers, lifecycle
    preload.ts                  contextBridge: desktopBridge + getPathForFile
    server-manager.ts           Child process lifecycle (spawn, restart, health check)
```

---

## Section 2: WebSocket RPC Protocol

### Message Formats

**Request-Response (client to server):**
```typescript
// Client sends:
{ id: "req_1", method: "thread.create", params: { workspaceId: "...", title: "...", mode: "direct", branch: "main" } }

// Server responds (success):
{ id: "req_1", result: { id: "...", title: "...", status: "active", ... } }

// Server responds (error):
{ id: "req_1", error: { code: "NOT_FOUND", message: "Workspace not found" } }
```

**Server Push (server broadcasts to client):**
```typescript
{ type: "push", channel: "agent.event", data: { threadId: "abc", event: { type: "toolUse", ... } } }
{ type: "push", channel: "terminal.data", data: { ptyId: "xyz", data: "$ ls\n" } }
```

### RPC Methods

All params and results are Zod-validated at the WebSocket boundary.

```typescript
export const WS_METHODS = {
  // Workspace
  "workspace.list":        { params: z.object({}), result: z.array(WorkspaceSchema) },
  "workspace.create":      { params: z.object({ name: z.string(), path: z.string() }), result: WorkspaceSchema },
  "workspace.delete":      { params: z.object({ id: z.string() }), result: z.boolean() },

  // Thread
  "thread.list":           { params: z.object({ workspaceId: z.string() }), result: z.array(ThreadSchema) },
  "thread.create":         { params: CreateThreadSchema, result: ThreadSchema },
  "thread.delete":         { params: z.object({ threadId: z.string(), cleanupWorktree: z.boolean() }), result: z.boolean() },
  "thread.updateTitle":    { params: z.object({ threadId: z.string(), title: z.string() }), result: z.boolean() },
  "thread.markViewed":     { params: z.object({ threadId: z.string() }), result: z.void() },

  // Git
  "git.listBranches":      { params: z.object({ workspaceId: z.string() }), result: z.array(GitBranchSchema) },
  "git.currentBranch":     { params: z.object({ workspaceId: z.string() }), result: z.string() },
  "git.checkout":          { params: z.object({ workspaceId: z.string(), branch: z.string() }), result: z.void() },
  "git.listWorktrees":     { params: z.object({ workspaceId: z.string() }), result: z.array(WorktreeSchema) },
  "git.fetchBranch":       { params: z.object({ workspaceId: z.string(), branch: z.string(), prNumber: z.number().optional() }), result: z.void() },

  // Agent
  "agent.send":            { params: SendMessageSchema, result: z.void() },
  "agent.createAndSend":   { params: CreateAndSendSchema, result: ThreadSchema },
  "agent.stop":            { params: z.object({ threadId: z.string() }), result: z.void() },
  "agent.activeCount":     { params: z.object({}), result: z.number() },

  // Messages
  "message.list":          { params: z.object({ threadId: z.string(), limit: z.number() }), result: z.array(MessageSchema) },

  // Files
  "file.list":             { params: z.object({ workspaceId: z.string(), threadId: z.string().optional() }), result: z.array(z.string()) },
  "file.read":             { params: z.object({ workspaceId: z.string(), relativePath: z.string(), threadId: z.string().optional() }), result: z.string() },

  // GitHub
  "github.branchPr":       { params: z.object({ branch: z.string(), cwd: z.string() }), result: PrInfoSchema.nullable() },
  "github.listOpenPrs":    { params: z.object({ workspaceId: z.string() }), result: z.array(PrDetailSchema) },
  "github.prByUrl":        { params: z.object({ url: z.string() }), result: PrDetailSchema.nullable() },

  // Config
  "config.discover":       { params: z.object({ workspacePath: z.string() }), result: z.record(z.unknown()) },

  // Skills
  "skill.list":            { params: z.object({ cwd: z.string().optional() }), result: z.array(SkillInfoSchema) },

  // Terminal
  "terminal.create":       { params: z.object({ threadId: z.string() }), result: z.string() },
  "terminal.write":        { params: z.object({ ptyId: z.string(), data: z.string() }), result: z.void() },
  "terminal.resize":       { params: z.object({ ptyId: z.string(), cols: z.number(), rows: z.number() }), result: z.void() },
  "terminal.kill":         { params: z.object({ ptyId: z.string() }), result: z.void() },
  "terminal.killByThread": { params: z.object({ threadId: z.string() }), result: z.void() },

  // Meta
  "app.version":           { params: z.object({}), result: z.string() },  // reads MCODE_VERSION env var, falls back to package.json version
} as const;
```

### Push Channels

```typescript
export const WS_CHANNELS = {
  "agent.event":      AgentEventSchema,
  "terminal.data":    z.object({ ptyId: z.string(), data: z.string() }),
  "terminal.exit":    z.object({ ptyId: z.string(), code: z.number() }),
  "thread.status":    z.object({ threadId: z.string(), status: ThreadStatusSchema }),
  "files.changed":    z.object({ workspaceId: z.string(), threadId: z.string().optional() }),
  "skills.changed":   z.object({}),
} as const;
```

### Agent Event Schema (cleaned up)

Removed dead fields from audit: `session.delta` (never emitted), `messageId` (always null), `type` field on message params (always "assistant"), `bridge.crashed` (vestigial).

```typescript
export const AgentEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message"),      threadId: z.string(), content: z.string(), tokens: z.number().nullable() }),
  z.object({ type: z.literal("toolUse"),       threadId: z.string(), toolCallId: z.string(), toolName: z.string(), toolInput: z.record(z.unknown()) }),
  z.object({ type: z.literal("toolResult"),    threadId: z.string(), toolCallId: z.string(), output: z.string(), isError: z.boolean() }),
  z.object({ type: z.literal("turnComplete"),  threadId: z.string(), reason: z.string(), costUsd: z.number().nullable(), tokensIn: z.number(), tokensOut: z.number() }),
  z.object({ type: z.literal("error"),         threadId: z.string(), error: z.string() }),
  z.object({ type: z.literal("ended"),         threadId: z.string() }),
  z.object({ type: z.literal("system"),        threadId: z.string(), subtype: z.string() }),
]);
```

### Electron IPC (desktopBridge only)

Only truly native operations stay as Electron IPC:

```typescript
interface DesktopBridge {
  getServerUrl(): Promise<string>;
  showOpenDialog(options: { title?: string }): Promise<string | null>;
  openInEditor(editor: string, dirPath: string): void;
  openInExplorer(dirPath: string): void;
  openExternalUrl(url: string): void;
  detectEditors(): Promise<string[]>;
  readClipboardImage(): Promise<AttachmentMeta | null>;
  getLogPath(): string;
  getRecentLogs(lines: number): string;
  getPathForFile(file: File): string;  // Synchronous, requires DOM File object
}
```

### Authentication

The server only accepts WebSocket connections with a valid auth token:

```typescript
// Server validates on connection
wss.on("connection", (ws, req) => {
  const url = new URL(req.url!, "http://localhost");
  const token = url.searchParams.get("token");
  if (token !== expectedAuthToken) {
    ws.close(4001, "Unauthorized");
    return;
  }
});
```

---

## Section 3: Service Layer and Dependency Injection

### tsyringe Composition Root

```typescript
// server/src/container.ts
import "reflect-metadata";
import { container, Lifecycle } from "tsyringe";

// Database
container.register("Database", { useFactory: () => openDatabase(dbPath) }, { lifecycle: Lifecycle.Singleton });

// Repositories
container.register("IWorkspaceRepo",  { useClass: WorkspaceRepo },  { lifecycle: Lifecycle.Singleton });
container.register("IThreadRepo",     { useClass: ThreadRepo },     { lifecycle: Lifecycle.Singleton });
container.register("IMessageRepo",    { useClass: MessageRepo },    { lifecycle: Lifecycle.Singleton });

// Providers
container.register("IAgentProvider",  { useClass: ClaudeProvider },  { lifecycle: Lifecycle.Singleton });
// Future: container.register("IAgentProvider", { useClass: CodexProvider }, ...);
// Future: container.register("IAgentProvider", { useClass: GeminiProvider }, ...);

container.register("IProviderRegistry", { useClass: ProviderRegistry }, { lifecycle: Lifecycle.Singleton });

// Services
container.register("IAgentService",      { useClass: AgentService },      { lifecycle: Lifecycle.Singleton });
container.register("IWorkspaceService",  { useClass: WorkspaceService },  { lifecycle: Lifecycle.Singleton });
container.register("IThreadService",     { useClass: ThreadService },     { lifecycle: Lifecycle.Singleton });
container.register("IGitService",        { useClass: GitService },        { lifecycle: Lifecycle.Singleton });
container.register("IGitHubService",     { useClass: GitHubService },     { lifecycle: Lifecycle.Singleton });
container.register("IFileService",       { useClass: FileService },       { lifecycle: Lifecycle.Singleton });
container.register("ITerminalService",   { useClass: TerminalService },   { lifecycle: Lifecycle.Singleton });
container.register("IConfigService",     { useClass: ConfigService },     { lifecycle: Lifecycle.Singleton });
container.register("ISkillService",      { useClass: SkillService },      { lifecycle: Lifecycle.Singleton });
container.register("IAttachmentService", { useClass: AttachmentService }, { lifecycle: Lifecycle.Singleton });
```

### Provider Interface

```typescript
export type ProviderId = "claude" | "codex" | "gemini" | "copilot";

export interface IAgentProvider {
  readonly id: ProviderId;

  sendMessage(params: {
    sessionId: string;
    message: string;
    cwd: string;
    model: string;
    resume: boolean;
    permissionMode: string;
    attachments?: AttachmentMeta[];
  }): void;

  stopSession(sessionId: string): void;
  setSdkSessionId(sessionId: string, sdkSessionId: string): void;
  shutdown(): void;

  on(event: "event", handler: (event: AgentEvent) => void): void;
  on(event: "error", handler: (error: Error) => void): void;
}
```

### Provider Registry

```typescript
@injectable()
class ProviderRegistry implements IProviderRegistry {
  private map: Map<ProviderId, IAgentProvider>;

  constructor(@injectAll("IAgentProvider") providers: IAgentProvider[]) {
    this.map = new Map(providers.map(p => [p.id, p]));
  }

  resolve(id: ProviderId): IAgentProvider {
    const provider = this.map.get(id);
    if (!provider) throw new Error(`Unknown provider: ${id}`);
    return provider;
  }

  resolveAll(): IAgentProvider[] {
    return Array.from(this.map.values());
  }

  shutdown(): void {
    for (const provider of this.map.values()) provider.shutdown();
  }
}
```

### Layer Responsibilities

| Layer | Responsibility | Example |
|-------|---------------|---------|
| Transport | WebSocket RPC routing, Zod validation, push broadcasting | `ws-router.ts` |
| Service | Business logic, orchestration, transaction rollback | `AgentService`, `ThreadService` |
| Repository | Data access, row-to-object mapping | `ThreadRepo`, `MessageRepo` |
| Provider | External service adapters | `ClaudeProvider`, `GitService` |
| Store (persistence) | SQLite schema, migrations | `database.ts` |

Services depend on repositories and providers via interfaces. No service imports another service's implementation directly.

### Session Architecture (preserved from current)

The Claude provider preserves the prompt queue pattern:

- `query()` called once per session with an `AsyncIterable<SDKUserMessage>`
- Messages pushed to the queue feed the existing subprocess without cold-starting
- MCP servers, context, and session state persist across turns
- Session pool with idle eviction (10-minute TTL)
- Resume with `sdk_session_id` after app restart, fallback to fresh query on failure

The server process is long-lived (spawned once by desktop, lives until app closes), so the session pool persists naturally.

---

## Section 4: Desktop Shell

### Server Manager

```typescript
// desktop/src/server-manager.ts

class ServerManager {
  private serverProcess: ChildProcess | null = null;
  private port: number;
  private authToken: string;

  async start(): Promise<{ port: number; authToken: string }> {
    this.port = await findAvailablePort(19400, 19500);
    this.authToken = crypto.randomUUID();

    this.serverProcess = fork(serverEntryPath, [], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        MCODE_PORT: String(this.port),
        MCODE_AUTH_TOKEN: this.authToken,
        MCODE_MODE: "desktop",
        MCODE_DATA_DIR: mcodeDataDir,
        MCODE_TEMP_DIR: app.getPath("temp"),
        MCODE_VERSION: app.getVersion(),
      },
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });

    await this.waitForReady(10_000);
    return { port: this.port, authToken: this.authToken };
  }

  async restart(): Promise<void> { /* kill + start */ }

  shutdown(): void {
    if (this.serverProcess) {
      this.serverProcess.kill("SIGTERM");
      // Force kill after 5s grace period
      setTimeout(() => this.serverProcess?.kill("SIGKILL"), 5000);
    }
  }
}
```

### Main Process

```typescript
// desktop/src/main.ts

app.whenReady().then(async () => {
  const server = new ServerManager();
  const { port, authToken } = await server.start();

  // Register mcode-attachment:// protocol for inline attachment display
  protocol.handle("mcode-attachment", serveAttachmentFile);

  const win = new BrowserWindow({
    width: 1200, height: 800,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // IPC handlers for native-only features
  ipcMain.handle("get-server-url", () => `ws://localhost:${port}?token=${authToken}`);
  ipcMain.handle("show-open-dialog", async (_, opts) => { /* dialog.showOpenDialog */ });
  ipcMain.handle("open-in-editor", (_, editor, path) => { /* execFile */ });
  ipcMain.handle("open-in-explorer", (_, path) => { /* shell.openPath */ });
  ipcMain.handle("open-external-url", (_, url) => { /* shell.openExternal */ });
  ipcMain.handle("detect-editors", () => { /* check PATH */ });
  ipcMain.handle("read-clipboard-image", async () => { /* clipboard.readImage -> temp JPEG */ });
  ipcMain.handle("get-log-path", () => getLogPath());
  ipcMain.handle("get-recent-logs", (_, lines) => getRecentLogs(lines));

  // Load web app
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(join(__dirname, "../renderer/index.html"));
  }

  // Close handler: check agent count via HTTP to server
  win.on("close", async (e) => { /* confirm dialog if agents running */ });

  // macOS: re-create window on dock click
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      server.shutdown();
      app.quit();
    }
  });

  app.on("before-quit", () => server.shutdown());
});
```

### Preload

```typescript
// desktop/src/preload.ts
import { contextBridge, ipcRenderer, webUtils } from "electron";

contextBridge.exposeInMainWorld("desktopBridge", {
  getServerUrl:      ()              => ipcRenderer.invoke("get-server-url"),
  showOpenDialog:    (opts)          => ipcRenderer.invoke("show-open-dialog", opts),
  openInEditor:      (editor, path)  => ipcRenderer.invoke("open-in-editor", editor, path),
  openInExplorer:    (path)          => ipcRenderer.invoke("open-in-explorer", path),
  openExternalUrl:   (url)           => ipcRenderer.invoke("open-external-url", url),
  detectEditors:     ()              => ipcRenderer.invoke("detect-editors"),
  readClipboardImage:()              => ipcRenderer.invoke("read-clipboard-image"),
  getLogPath:        ()              => ipcRenderer.invoke("get-log-path"),
  getRecentLogs:     (lines)         => ipcRenderer.invoke("get-recent-logs", lines),
  getPathForFile:    (file)          => webUtils.getPathForFile(file),  // Synchronous
});
```

### Server Graceful Shutdown

The server handles SIGTERM to replicate the current `state.shutdown()` sequence:

```typescript
// server/src/index.ts
process.on("SIGTERM", async () => {
  // 1. Stop all active agent sessions
  const agentService = container.resolve<IAgentService>("IAgentService");
  await agentService.stopAll();

  // 2. Shutdown all providers (closes SDK subprocesses)
  const registry = container.resolve<IProviderRegistry>("IProviderRegistry");
  registry.shutdown();

  // 3. Mark active threads as "interrupted" in DB
  const threadService = container.resolve<IThreadService>("IThreadService");
  threadService.markActiveAsInterrupted();

  // 4. Shutdown terminal service (kill all PTYs)
  const terminalService = container.resolve<ITerminalService>("ITerminalService");
  terminalService.shutdown();

  // 5. Close database
  const db = container.resolve<Database>("Database");
  db.close();

  process.exit(0);
});
```

---

## Section 5: Web App Transport Swap

### WebSocket Transport

```typescript
// web/src/transport/ws-transport.ts

export function createWsTransport(url: string): McodeTransport & { close(): void } {
  const ws = new WebSocket(url);
  const pending = new Map<string, { resolve: Function; reject: Function }>();
  let idCounter = 0;

  // Connection readiness queue: buffers RPC calls until WS is open
  const ready = new Promise<void>((resolve) => { ws.onopen = () => resolve(); });

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }
    if (msg.type === "push") {
      pushEmitter.emit(msg.channel, msg.data);
    }
  };

  async function rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
    await ready;
    return new Promise((resolve, reject) => {
      const id = `req_${++idCounter}`;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  return {
    listWorkspaces: ()                => rpc("workspace.list", {}),
    createWorkspace: (name, path)     => rpc("workspace.create", { name, path }),
    deleteWorkspace: (id)             => rpc("workspace.delete", { id }),
    // ... every McodeTransport method maps to one rpc() call
    close: () => ws.close(),
  };
}
```

### Reconnection Strategy

The WebSocket transport includes automatic reconnection:

- Exponential backoff (1s, 2s, 4s, 8s, max 30s)
- Re-subscribe to push channels on reconnect
- Pending RPC calls rejected on disconnect with retriable error
- UI toast notification on disconnect/reconnect

### Files Changed

| File | Change |
|------|--------|
| `transport/index.ts` | Remove Tauri/Electron detection. WS factory with ready queue. |
| `transport/ws-transport.ts` | **New**: WebSocket RPC client + push emitter + reconnection |
| `transport/ws-events.ts` | **New**: Push channel listeners for agent, terminal, file events |
| `transport/desktop-bridge.d.ts` | **New**: Type declarations for `window.desktopBridge` |
| `transport/electron.ts` | **Delete** |
| `transport/tauri.ts` | **Delete** |
| `transport/events.ts` | **Delete** (replaced by ws-events.ts) |
| `transport/electron-api.d.ts` | **Delete** (replaced by desktop-bridge.d.ts) |
| `stores/threadStore.ts` | Remove legacy CLI event handlers (lines 560-642). Remove `bridge.crashed` handler. |
| `components/terminal/TerminalView.tsx` | Migrate `window.electronAPI` PTY calls to WS transport |
| `components/terminal/TerminalPanel.tsx` | Migrate `window.electronAPI` PTY calls to WS transport |
| `components/sidebar/ProjectTree.tsx` | Migrate `electronAPI.invoke("show-open-dialog")` to `desktopBridge.showOpenDialog()` |
| `components/chat/Composer.tsx` | Migrate `electronAPI.getPathForFile` to `desktopBridge.getPathForFile()` |
| `components/chat/PrBadge.tsx` | Migrate `electronAPI.invoke("open-external-url")` to `desktopBridge.openExternalUrl()` |
| `components/chat/useFileAutocomplete.ts` | Add cache invalidation on `files.changed` push event |
| `app/App.tsx` | Update event listener setup to use `ws-events.ts` |
| `__tests__/mocks/transport.ts` | Update mock to match interface changes |

---

## Dead Code Removal

### Files to delete

| File | Reason |
|------|--------|
| `apps/web/src/transport/tauri.ts` | 20/27 methods throw "Not implemented". Dead code. |
| `apps/web/src/transport/electron.ts` | Replaced by ws-transport.ts |
| `apps/web/src/transport/events.ts` | Replaced by ws-events.ts |
| `apps/web/src/transport/electron-api.d.ts` | Replaced by desktop-bridge.d.ts |

### Code to remove

| Location | What | Reason |
|----------|------|--------|
| `sidecar/types.ts:19-24` | `session.delta` event type | Defined but never emitted by client.ts |
| `sidecar/client.ts:121,133-136` | `isReady()` / `ready` field | Always true. In-process SDK has no startup delay. |
| `threadStore.ts:560-642` | Legacy CLI event handlers | `assistant`, `content_block_delta`, `result`, `agent_finished` types unused. |
| `threadStore.ts:264-273` | `bridge.crashed` handler | Vestigial from child process era. |
| Stale comments | "Ported from lib.rs", "matching Rust SidecarEvent enum", etc. | Rust codebase is gone. |

### DB fields to remove

| Field | Model | Reason |
|-------|-------|--------|
| `pid` | Thread | Never written to. Always null. |
| `session_name` | Thread | Always derived as `"mcode-${id}"`. Redundant. |

### DB fields to keep

| Field | Model | Reason |
|-------|-------|--------|
| `provider_config` | Workspace | Currently `{}`, but needed for multi-provider configuration. |

### Event fields to clean up

| Field | Event | Reason |
|-------|-------|--------|
| `messageId` | session.message | Always null. Remove from event, generate client-side. |
| `type` (params) | session.message | Always "assistant". Redundant with method name. |

---

## File List and Skills Cache Fix

### Problem

1. `useFileAutocomplete.ts` caches file lists in a module-level Map that never invalidates during active sessions.
2. `git ls-files` only returns tracked files. Untracked new files created by the agent don't appear.
3. Skills cache in `useSlashCommand.ts` uses a TTL but doesn't respond to filesystem changes.

### Solution

**Automatic push-based invalidation:**
- Server broadcasts `files.changed` push event after agent `turnComplete` events.
- Server broadcasts `skills.changed` push event when skill directories change.
- Client drops cache on receipt, lazily re-fetches on next `@` trigger or `/` trigger.

**Fix `git ls-files`:**
```
git ls-files --cached --others --exclude-standard
```
This includes untracked files (excluding gitignored) in addition to tracked files.

**Manual `/refresh` slash command:**
- Built-in mcode command (not a skill, not sent to the agent).
- Clears file list cache and skills cache.
- Re-fetches both immediately.
- Shows brief toast confirmation.
- Fallback for external edits not detected by the server.

---

## Migration Path

This is a full refactor executed in one pass. The high-level order:

1. Create `packages/contracts` with all shared types and Zod schemas
2. Create `packages/shared` with extracted utilities
3. Create `apps/server` with service layer, DI, repositories, providers, WebSocket transport
4. Migrate `SidecarClient` to `ClaudeProvider` (same logic, new interface)
5. Swap `apps/web` transport from Electron IPC to WebSocket
6. Migrate 5 component files from `window.electronAPI` to `desktopBridge` / WS transport
7. Gut `apps/desktop` down to thin shell with `ServerManager`
8. Remove dead code, stale comments, unused fields
9. Add DB migration to drop `pid` and `session_name` columns
10. Update tests and mocks
