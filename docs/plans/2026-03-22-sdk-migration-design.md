# Claude Agent SDK Migration: Design Plan

*Date: 2026-03-22*
*Status: Draft*

## Problem

The current approach of spawning the `claude` CLI with `--output-format stream-json` and parsing stdout does not reliably deliver AI responses to the UI. The CLI's output format is complex, events are dropped by our parser, and there's no proper session management.

## Solution

Replace CLI spawning with the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), accessed via a Node.js sidecar process that communicates with Rust over JSON-RPC.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Tauri App (Rust)                                       │
│                                                         │
│  ┌──────────────┐    JSON-RPC     ┌──────────────────┐  │
│  │ mcode-core   │ ◄──stdin/out──► │ Node.js Sidecar  │  │
│  │              │                  │                  │  │
│  │ ProcessMgr   │  spawn/manage   │ claude-bridge.mjs│  │
│  │ (refactored) │ ──────────────► │                  │  │
│  └──────────────┘                  │ Uses:            │  │
│         │                          │ @anthropic-ai/   │  │
│         ▼                          │ claude-agent-sdk │  │
│  ┌──────────────┐                  │                  │  │
│  │ Tauri emit   │                  │ query() async    │  │
│  │ to frontend  │                  │ generator        │  │
│  └──────────────┘                  └──────────────────┘  │
├─────────────────────────────────────────────────────────┤
│  React Frontend (unchanged)                             │
│  Receives events via Tauri event system                 │
└─────────────────────────────────────────────────────────┘
```

## Node.js Sidecar: `claude-bridge.mjs`

A small (~200 line) Node script that:

1. Reads JSON-RPC requests from stdin
2. Manages Claude SDK sessions via `query()`
3. Streams SDK messages back as JSON-RPC notifications on stdout

### JSON-RPC Protocol

**Requests (Rust -> Node):**

```json
// Start a new session/turn
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "session.sendMessage",
  "params": {
    "sessionId": "mcode-thread-uuid",
    "message": "Fix the auth bug",
    "cwd": "/path/to/project",
    "model": "claude-sonnet-4-6",
    "resumeSession": true,
    "interactionMode": "chat",
    "permissionMode": "full"
  }
}

// Stop/interrupt a session
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session.stop",
  "params": { "sessionId": "mcode-thread-uuid" }
}
```

**Responses (Node -> Rust):**

```json
// Acknowledgement
{ "jsonrpc": "2.0", "id": 1, "result": { "ok": true } }
```

**Notifications (Node -> Rust, streaming):**

```json
// Assistant text (complete message)
{
  "jsonrpc": "2.0",
  "method": "session.message",
  "params": {
    "sessionId": "mcode-thread-uuid",
    "type": "assistant",
    "content": "Here's the fix...",
    "messageId": "msg_123",
    "tokens": 150,
    "costUsd": 0.01
  }
}

// Streaming text delta
{
  "jsonrpc": "2.0",
  "method": "session.delta",
  "params": {
    "sessionId": "mcode-thread-uuid",
    "text": "partial text..."
  }
}

// Turn complete
{
  "jsonrpc": "2.0",
  "method": "session.turnComplete",
  "params": {
    "sessionId": "mcode-thread-uuid",
    "reason": "end_turn"
  }
}

// Tool use (for permission handling)
{
  "jsonrpc": "2.0",
  "method": "session.toolUse",
  "params": {
    "sessionId": "mcode-thread-uuid",
    "toolName": "Edit",
    "toolInput": { "file_path": "src/main.rs", "old_string": "...", "new_string": "..." }
  }
}

// Error
{
  "jsonrpc": "2.0",
  "method": "session.error",
  "params": {
    "sessionId": "mcode-thread-uuid",
    "error": "API rate limited"
  }
}
```

### Sidecar Implementation Sketch

```javascript
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createInterface } from "readline";

const sessions = new Map(); // sessionId -> AbortController

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  const req = JSON.parse(line);

  if (req.method === "session.sendMessage") {
    const { sessionId, message, cwd, model, permissionMode } = req.params;

    // Respond immediately
    send({ jsonrpc: "2.0", id: req.id, result: { ok: true } });

    // Start streaming in background
    const abortController = new AbortController();
    sessions.set(sessionId, abortController);

    try {
      for await (const msg of query({
        prompt: message,
        options: {
          cwd,
          model,
          sessionName: sessionId,
          resume: req.params.resumeSession,
          permissionMode: permissionMode === "full"
            ? "dangerouslySkipPermissions"
            : "default",
          includePartialMessages: true,
          abortController,
        },
      })) {
        if (msg.type === "assistant") {
          const text = msg.message.content
            .filter(b => b.type === "text")
            .map(b => b.text)
            .join("");
          notify("session.message", {
            sessionId,
            type: "assistant",
            content: text,
            messageId: msg.message.id,
            tokens: msg.message.usage?.output_tokens ?? null,
          });
        } else if (msg.type === "result") {
          notify("session.turnComplete", {
            sessionId,
            reason: msg.subtype,
            costUsd: msg.costUSD ?? null,
            tokensUsed: msg.totalTokensIn + msg.totalTokensOut,
          });
        }
      }
    } catch (e) {
      notify("session.error", { sessionId, error: e.message });
    } finally {
      sessions.delete(sessionId);
    }
  }

  if (req.method === "session.stop") {
    const controller = sessions.get(req.params.sessionId);
    if (controller) controller.abort();
    send({ jsonrpc: "2.0", id: req.id, result: { ok: true } });
  }
});

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}
```

## Rust Changes

### 1. Replace `ClaudeProvider` with `SidecarProvider`

Instead of spawning `claude` CLI, spawn `node claude-bridge.mjs` and communicate via JSON-RPC over stdin/stdout.

```rust
pub struct SidecarProvider {
    child: Child,
    stdin: tokio::io::BufWriter<ChildStdin>,
    // stdout is read in a background task
}

impl SidecarProvider {
    pub fn start() -> Result<Self> { /* spawn node sidecar */ }
    pub async fn send_message(&mut self, req: JsonRpcRequest) -> Result<()> { /* write to stdin */ }
}
```

### 2. Refactor ProcessManager

Instead of managing individual Claude CLI processes, manage communication with the single sidecar process. Route messages by `sessionId`.

### 3. Parse JSON-RPC notifications from sidecar stdout

Background task reads stdout lines, parses JSON-RPC notifications, and emits Tauri events to the frontend.

## Frontend Changes

### Minimal changes needed

The frontend already handles events via `handleAgentEvent`. Just need to update the event types to match the new JSON-RPC notification format:

- `session.message` -> commit assistant message
- `session.delta` -> append to streamingByThread
- `session.turnComplete` -> clear running state
- `session.error` -> set error state

### Additional features to wire

- **Model locked per thread**: Store selected model in thread DB record. Composer reads from thread, not local state.
- **Branch from git**: Add a Tauri command that runs `git branch --show-current` in the workspace dir.
- **Permission mode per thread**: Store with thread settings.

## File Structure

```
apps/
  sidecar/
    package.json            # @anthropic-ai/claude-agent-sdk dependency
    claude-bridge.mjs       # The sidecar script (~200 lines)
  desktop/
    src/lib.rs              # Updated to spawn and manage sidecar
  web/
    src/stores/threadStore.ts  # Updated event handling
crates/
  mcode-core/
    src/process/
      sidecar.rs            # New: JSON-RPC communication with sidecar
      manager.rs            # Refactored: routes to sidecar, not CLI
      provider.rs           # Deprecated or removed
```

## Migration Steps

1. Create `apps/sidecar/` with package.json and `claude-bridge.mjs`
2. Create `crates/mcode-core/src/process/sidecar.rs` for JSON-RPC communication
3. Refactor `ProcessManager` to use sidecar instead of direct CLI spawning
4. Update `apps/desktop/src/lib.rs` to start sidecar on app launch
5. Update `threadStore.ts` event handling for new notification format
6. Add model/permission storage to Thread DB model
7. Add git branch Tauri command
8. Test end-to-end: send message -> see streaming response
9. Remove old `ClaudeProvider` and `stream.rs` parser

## Testing Strategy

- **Sidecar unit tests**: Mock the SDK, verify JSON-RPC protocol
- **Rust integration tests**: Spawn sidecar, send request, verify notification format
- **Frontend behavioral tests**: Update existing streaming tests for new event format
- **E2E**: Send a real message, see response in UI

## Risk Mitigation

- Keep old `provider.rs` until new approach is confirmed working
- Sidecar can be tested standalone: `echo '{"jsonrpc":"2.0","id":1,"method":"session.sendMessage","params":{...}}' | node claude-bridge.mjs`
- If SDK doesn't work, fallback: use CLI with `--include-partial-messages` flag (which we haven't tried yet)
