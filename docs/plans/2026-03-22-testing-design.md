# Mcode Testing Strategy: Phase 6 Behavioral Tests

*Date: 2026-03-22*
*Status: Approved*

## Goal

Add behavioral tests covering critical paths: streaming pipeline, thread lifecycle, workspace management, and thread creation dialog. Each test describes a user-visible outcome, not an implementation detail.

## Approach

Frontend tests use vitest with Zustand store testing (direct store manipulation, no Tauri runtime needed). Rust tests use cargo test with in-memory fixtures.

## Frontend Tests (~18 tests)

### Streaming Behavior
- When an agent streams text, the correct thread shows the content
- When two agents stream simultaneously, their outputs stay separate
- When the agent finishes, streaming content becomes a committed message
- When the user switches threads mid-stream, they see the right thread's content

### Thread Lifecycle
- When the user creates a thread, it appears in the list and becomes active
- When the user deletes a thread with a running agent, the agent stops first
- When the user sends a message to a deleted thread, it's rejected

### Workspace Behavior
- When the user opens a folder that's already a workspace, it activates the existing one
- When the user deletes the active workspace, threads and selection clear
- When the user switches workspaces rapidly, only the final workspace's threads show

### New Thread Dialog
- When the user submits with empty title, nothing happens
- When the user enters invalid branch characters, they see an error
- When creation fails, the dialog stays open with the error visible

## Rust Tests (~4 tests)

### Process Manager
- When take_events is called, the stream is consumed (second call returns None)
- When take_events is called for unknown thread, returns None

### Stream Parser
- When malformed JSON is received from the CLI, it's skipped without crashing
- When a tool_use content block is received, it parses correctly
