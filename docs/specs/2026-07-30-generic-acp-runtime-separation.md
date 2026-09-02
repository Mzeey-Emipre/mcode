# Generic ACP Runtime Separation

**Date:** 2026-07-30
**Status:** Specification
**Scope:** `apps/server/src/providers/cursor/` and a new ACP runtime module

## Purpose

Mcode currently implements Agent Client Protocol (ACP) lifecycle behavior inside
`CursorProvider`. A second ACP provider would need to duplicate process startup,
capability negotiation, authentication, logical-session setup, prompt
serialization, cancellation, request routing, and event delivery.

This specification extracts ACP-neutral behavior into a reusable runtime while
retaining Cursor's product behavior in the Cursor provider. The change does not
add Grok or alter the Codex provider.

## User Outcome

Cursor continues to behave exactly as it does today. A future ACP provider can
reuse one tested session runtime and add only its executable, authentication,
provider-specific extensions, model policy, and event interpretation.

## Decisions

1. Codex remains a dedicated `codex app-server` integration. It does not use
   ACP and is out of scope.
2. `SessionRuntime` remains the owner of provider process pooling, stale-session
   replacement, eviction, Job Object attachment, and hard process-tree cleanup.
3. The new ACP runtime owns one ACP child process and one logical ACP session
   for each Mcode session.
4. ACP standards behavior is shared. Cursor extension methods and Cursor's
   timeline semantics remain Cursor-owned.
5. The first extraction is behavior-preserving. It adds no provider, setting,
   UI, or protocol capability.
6. ACP is treated as an untrusted process boundary. The runtime validates
   protocol data before it crosses into Mcode contracts, and provider extension
   handlers validate their own payloads.

## Architecture

```text
CursorProvider implements ProtocolAdapter<CursorSessionState>
  |-- SessionRuntime: pooling, eviction, Windows process ownership
  |-- CursorAcpSessionAdapter: Cursor spawn policy and extensions
        |-- AcpSessionRuntime: child-process ACP transport and session lifecycle
        |     |-- initialize, authenticate, session/load or session/new
        |     |-- serialized session/prompt, session/cancel, connection close
        |     |-- capability-gated standard client handlers
        |     `-- normalized ACP session updates
        `-- Cursor extension bridge: permissions, files, MCP, plans, todos, tasks
              `-- Cursor event mapper: normalized ACP events to AgentEvent
```

The generic runtime must not import Cursor settings, Cursor prompt builders,
Cursor tool names, browser automation, thread-control MCP, or `AgentEvent`.
It exposes ACP-domain events and callbacks. `CursorAcpSessionAdapter` translates
those events and supplies Cursor-specific callbacks.

## Proposed Artifacts

| Path | Responsibility |
| --- | --- |
| `apps/server/src/providers/acp/acp-session-runtime.ts` | Start, initialize, authenticate, create or load a logical session, serialize prompts, cancel, close, and expose validated ACP events. |
| `apps/server/src/providers/acp/acp-session-types.ts` | Generic spawn, capabilities, session setup, prompt, event, and callback types. |
| `apps/server/src/providers/acp/acp-client-handlers.ts` | Capability-gated standard ACP client handlers for permission, filesystem, terminal, and generic extension dispatch. |
| `apps/server/src/providers/acp/acp-session-runtime.test.ts` | Runtime lifecycle, cancellation, capability, resume, and cleanup tests using the ACP mock peer. |
| `apps/server/src/providers/cursor/cursor-acp-session-adapter.ts` | Cursor implementation of the generic runtime callbacks and conversion to `CursorSessionState`. |
| `apps/server/src/providers/cursor/cursor-acp-event-bridge.ts` | Bridge generic ACP events to `cursor-acp-event-mapper.ts` and Cursor extension events. |
| `apps/server/src/providers/cursor/cursor-provider.ts` | Retain provider orchestration and `ProtocolAdapter`; delegate ACP mechanics to the Cursor ACP session adapter. |

Existing `cursor-acp-prompt.ts`, `cursor-acp-permission-mapper.ts`,
`cursor-acp-spawn-args.ts`, `cursor-acp-event-mapper.ts`,
`cursor-acp-task.ts`, and `cursor-acp-ask-question.ts` remain Cursor artifacts.

## Generic Contract

```ts
export type AcpSpawnSpec = {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
};

export type AcpSessionOpenInput = {
  resumeFrom?: string;
  cwd: string;
  mcpServers: readonly AcpMcpServer[];
};

export type AcpSessionCallbacks = {
  onPermissionRequest: (request: AcpPermissionRequest) => Promise<AcpPermissionOutcome>;
  onSessionUpdate: (update: AcpSessionUpdate) => Promise<void>;
  readTextFile?: (path: string) => Promise<string>;
  writeTextFile?: (path: string, content: string) => Promise<void>;
  onExtensionRequest?: (method: string, params: unknown) => Promise<unknown>;
  onExtensionNotification?: (method: string, params: unknown) => Promise<void>;
};

export type AcpSessionState = {
  child: ChildProcess;
  connection: ClientSideConnection;
  sessionId: string;
  agentCapabilities: AcpAgentCapabilities;
  activePrompt: Promise<AcpPromptResponse> | null;
};
```

The runtime sends `initialize` once, selects an advertised authentication method
through supplied policy, then uses `session/load` when a persisted provider
session exists or `session/new` otherwise. It must only issue `session/load`
when the agent advertises that capability. The runtime must serialize
`session/prompt` calls per logical ACP session.

`AcpSessionState` remains protocol-level. It must not contain thread IDs,
browser leases, permission cards, todo snapshots, Cursor model metadata, or
Mcode event accumulators.

## Cursor Adapter Contract

`CursorAcpSessionAdapter` owns these policies:

- Build `cursor-agent acp` arguments from Mcode permission mode.
- Probe available Cursor executables.
- Select Cursor authentication method.
- Build Mcode internal and browser MCP server declarations.
- Create and release browser automation leases.
- Read and write workspace files through the existing path-safe helpers.
- Translate ACP permission requests to `PermissionRequest` and map decisions
  back to ACP outcomes.
- Handle `cursor/ask_question`, `cursor/create_plan`, `cursor/task`, and
  `cursor/update_todos` extension methods.
- Build prompts from Cursor instructions and attachments.
- Map ACP session updates to Mcode `AgentEvent` values.
- Preserve Cursor's existing `session/load` fallback to `session/new`.

The generic runtime may expose an extension-method dispatcher, but it must not
recognize any `cursor/*` method or make a product decision from its payload.

## Lifecycle Rules

1. `SessionRuntime.acquire` invokes `CursorProvider.spawn` as it does today.
2. `CursorProvider.spawn` delegates child startup and ACP session setup to
   `CursorAcpSessionAdapter`.
3. The adapter gives the spawned child PID to `SessionRuntime` unchanged.
4. `SessionRuntime.stop` calls ACP `session/cancel`, then adapter cleanup, then
   performs the existing process-tree hard kill.
5. A runtime must reject or ignore session updates for a different logical ACP
   session. Child-session events need an explicit future lineage model; the
   extraction must not flatten them into the parent stream.
6. A failed spawn, handshake, authenticate, load, or new-session operation must
   close its connection and release only resources created for that attempt.
7. A cancelled turn must still emit Mcode's existing terminal event path exactly
   once.

## Migration Plan

1. Add generic ACP types and mock-driven runtime tests without changing Cursor.
2. Move child-process transport, handshake, authenticate, logical-session open,
   prompt serialization, cancellation, and transport disposal into the generic
   runtime.
3. Add `CursorAcpSessionAdapter` with the current Cursor callbacks and event
   bridge.
4. Replace the extracted code in `CursorProvider` with adapter delegation.
5. Keep the existing public provider behavior and test suite green.
6. Add no Grok provider in this change. A subsequent provider specification may
   consume the resulting seam.

## Acceptance Criteria

- Cursor starts the same `cursor-agent acp` command for each permission mode.
- Cursor preserves the current initialize, authenticate, `session/load`, and
  `session/new` fallback behavior.
- Cursor preserves attachment prompt blocks, internal MCP, browser MCP gating,
  permission cards, plans, todos, task/sub-agent events, and file mutation
  mapping.
- Session reuse, stale detection, idle eviction, interrupt, and hard kill remain
  owned by `SessionRuntime` and retain existing behavior.
- The generic ACP runtime has no Cursor imports and no Mcode `AgentEvent` import.
- A failed ACP startup does not retain a child, connection, pending permission,
  browser lease, or logical session registration.
- Existing Cursor focused tests pass unchanged unless their file path follows an
  extracted artifact.

## Test Plan

Add focused tests for:

- initialize capability negotiation and advertised-auth selection;
- no authenticate request when no method is selected;
- fresh session creation and capability-gated session load;
- Cursor's failed-load fallback to fresh-session creation;
- serialized prompts and `session/cancel` targeting the correct ACP session;
- unrelated session updates being ignored;
- cleanup after each setup-stage failure;
- delegation of Cursor extension requests and notifications;
- unchanged Cursor event-mapper fixtures and permission-mapper behavior;
- regression coverage for `SessionRuntime` PID handoff and stop order.

Run focused tests and typecheck after implementation because this extraction
changes cross-module TypeScript contracts.

## Out Of Scope

- Adding Grok, another ACP provider, or a provider picker entry.
- Refactoring Codex, Claude, Copilot, or OpenCode.
- Replacing the existing `SessionRuntime` lifecycle abstraction.
- Changing user-facing permission semantics, browser automation, or MCP policy.
- Rewriting Cursor event semantics to match another provider.
