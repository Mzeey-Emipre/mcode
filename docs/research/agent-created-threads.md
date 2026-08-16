# Agent-created threads

## Question

How can an agent running inside Mcode create another thread and continue interacting with it?

## Summary

Mcode should not expose its existing client RPCs directly to a provider process. It should add a small, authenticated orchestration capability at the Mcode server boundary. That capability should create a normal persisted Mcode thread, record its relationship to the parent, submit messages through `AgentService`, and return a bounded status/result view.

Codex app-server already creates internal child threads for subagents. Mcode currently maps those child events into nested tool calls inside the parent Mcode turn. Those provider threads are useful execution machinery, but they are not equivalent to durable, user-visible Mcode threads. Promoting them implicitly would mix two ownership models and would not generalize to other providers.

The recommended first slice is a provider-neutral set of Mcode tools:

- `workspace_search`: find registered Projects for internal callers and allowed Projects for external callers by name or repository identity.
- `worktree_list`: list opaque worktree handles for one Project.
- `thread_create_batch`: create and start one to twenty normal Mcode threads.
- `thread_search` and `thread_get`: find and read authorized threads, including existing threads the caller did not create.
- `thread_send`: submit a follow-up message.
- `thread_stop`: stop an active turn when the caller's authority permits it.
- `thread_wait`: wait for one or more exact threads to reach a terminal or attention-required state.

The user and an authorized agent may share control. Every action must remain visible in both the source and destination threads. An internal caller may target any Workspace registered for the user. An external caller may target only a selected Workspace. The destination does not need to match the caller's workspace. `workspaceId` is the Project ID in all wire contracts.

## Existing Mcode seams

### Current capability matrix

Mcode has most execution primitives behind its trusted client WebSocket, but none are exposed as an in-app, model-callable Mcode MCP or tool surface. Provider MCP support currently concerns provider-configured servers and startup events, not Mcode thread control.

| Capability                                  | Current internal service or RPC                                                                                                                                                                                                                  | Model-callable today          | Gap                                                                                                                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discover Projects                           | `workspace.list` returns all Workspaces (`packages/contracts/src/ws/methods.ts:210-213`; `apps/server/src/transport/ws-router.ts:393-394`).                                                                                                      | No                            | Add a bounded authorized Project catalog.                                                                                                                                                |
| List worktrees                              | `git.listWorktrees` takes `workspaceId` (`packages/contracts/src/ws/methods.ts:402-405`; `apps/server/src/transport/ws-router.ts:647-650`).                                                                                                      | No                            | Return opaque selectable placement identities instead of accepting arbitrary paths.                                                                                                      |
| Create and start one thread                 | `agent.createAndSend` combines creation and first send (`packages/contracts/src/ws/methods.ts:534-537`; `apps/server/src/transport/ws-router.ts:758-765`).                                                                                       | No                            | Wrap it in an authenticated agent capability and derive creator lineage.                                                                                                                 |
| Batch create                                | No batch contract exists; `CreateAndSendSchema` describes one item (`packages/contracts/src/ws/methods.ts:145-192`).                                                                                                                             | No                            | Add bounded batch input and per-item results.                                                                                                                                            |
| Send a message                              | `agent.send` accepts a target `threadId` and turn controls (`packages/contracts/src/ws/methods.ts:90-139`, `packages/contracts/src/ws/methods.ts:530-533`).                                                                                      | No                            | Add target authorization, provenance, and defined busy-thread behavior.                                                                                                                  |
| Read transcript and status                  | `message.list` and `conversation.page` provide bounded transcript pages (`packages/contracts/src/ws/methods.ts:605-619`); thread records returned by `thread.list` carry status.                                                                 | No                            | Add one bounded agent-facing read view and redact data outside its grant.                                                                                                                |
| List and filter threads                     | `thread.list` filters only by required `workspaceId`; `thread.recent` is cross-Workspace but only accepts a limit (`packages/contracts/src/ws/methods.ts:270-281`).                                                                              | No                            | Add bounded filters such as IDs, creator, status, and Project.                                                                                                                           |
| Wait                                        | No wait RPC exists. Running IDs are available only as a global snapshot through `agent.listRunning` (`packages/contracts/src/ws/methods.ts:546-549`).                                                                                            | No                            | Add bounded waiting for exact thread IDs and attention or terminal states.                                                                                                               |
| Stop or interrupt                           | `agent.stop` stops the session identified by `threadId` (`packages/contracts/src/ws/methods.ts:538-541`; `apps/server/src/transport/ws-router.ts:767-769`).                                                                                      | No                            | Add target authorization and precise stop or interrupt semantics.                                                                                                                        |
| Cross-Project creation                      | `workspaceId` is required by both creation schemas and is passed to the creation services (`packages/contracts/src/ws/methods.ts:80-86`, `packages/contracts/src/ws/methods.ts:146-149`; `apps/server/src/features/agents/orchestration/agent-service.ts:1118-1119`). | No                            | The primitive works across Projects, but an agent needs a discovery surface and a caller authority appropriate to the internal or external boundary.                                     |
| Direct, new, or existing worktree placement | Direct and new worktree use `mode`; existing worktree uses `existingWorktreePath` and optional base branch (`packages/contracts/src/ws/methods.ts:153-157`; `apps/server/src/features/agents/orchestration/agent-service.ts:1165-1196`).                              | No                            | Replace model-authored paths with catalog IDs and make resolved placement explicit.                                                                                                      |
| Default provider and model                  | The service permits omission internally, but hard-codes Claude and `claude-sonnet-4-6` defaults (`apps/server/src/features/agents/orchestration/agent-service.ts:102-110`, `apps/server/src/features/agents/orchestration/agent-service.ts:1118-1131`).                                    | No                            | Resolve the user's configured defaults on the server; exact requested values must succeed or error.                                                                                      |
| Permission and Plan or Build controls       | Send and create-and-send accept optional `permissionMode` and `interactionMode` (`packages/contracts/src/ws/methods.ts:100-109`, `packages/contracts/src/ws/methods.ts:152-166`).                                                                | No                            | Enforce a permission ceiling and keep Build as the omitted interaction default.                                                                                                          |
| Message origin provenance                   | Persisted messages contain role, thread, content, and optional assistant model, but no composer or source-thread origin (`packages/contracts/src/models/message.ts:8-40`).                                                                       | No                            | Persist `composer                                                                                                                                                                        | thread` origin with source thread, turn, and provider captured by Mcode. |
| Authorization                               | The client transport authenticates a connection token and, in single-instance mode, its instance and worktree identity (`apps/server/src/transport/auth.ts:13-45`; `apps/server/src/transport/ws-server.ts:66-98`).                              | No agent-scoped authorization | Derive internal authority from the active provider session. Give external integrations selected Projects and explicit scopes. Never expose the broad WebSocket credential to a provider. |

Conclusion: the current structure can perform single-thread create/start, send, read, list, cross-Project placement, and stop once trusted server code calls the existing seams. It cannot safely give those actions to a running agent until Mcode adds the agent-facing capability boundary, provenance, filtering/waiting, batch behavior, server-side default resolution, and authorization.

### Client RPC contracts

Mcode already has client-facing contracts for the underlying operations:

- `CreateThreadSchema` requires a workspace, title, composer mode, and branch selection (`packages/contracts/src/ws/methods.ts:80-86`).
- `SendMessageSchema` accepts the thread, content, provider settings, permission mode, budget, mentions, attachments, and related turn inputs (`packages/contracts/src/ws/methods.ts:90-139`).
- `CreateAndSendSchema` combines placement and first-turn input and already carries optional fork lineage (`packages/contracts/src/ws/methods.ts:146-192`).
- The WebSocket method table exposes `thread.create`, `agent.send`, `agent.createAndSend`, thread subscription, and persisted conversation reads (`packages/contracts/src/ws/methods.ts:283-286`, `packages/contracts/src/ws/methods.ts:530-556`, `packages/contracts/src/ws/methods.ts:605-619`).

These are suitable service inputs, but unsuitable agent tool contracts. Several thread IDs are only validated as strings, and the WebSocket connection has broad access after authentication. Agent tools need a narrower capability context and bounded result types.

### Thread creation and persistence

`ThreadService.create()` is the server-side creation seam. It validates workspace and worktree choices, creates any required worktree, and persists the thread through the thread repository. The repository owns durable thread records rather than the provider session (`apps/server/src/features/thread-control/lifecycle/thread-service.ts:30`, `apps/server/src/repositories/thread-repo.ts:115`).

The existing model already distinguishes a Mcode thread from a provider session. A thread belongs to a workspace and may run directly in the workspace, in a new worktree, or in an existing worktree (`CONTEXT.md`, “Thread” and “Composer mode”).

Code and wire contracts call the destination `workspaceId`. There is no separate `projectId` in the creation contract. The UI term Project refers to the same entity.

Current placement inputs are:

- Direct: `mode: "direct"` and `branch`. No worktree is provisioned.
- New worktree: `mode: "worktree"`, `branch`, and `worktreeBranchMode`. `branch` is the base ref for a branchless worktree or the named branch for named mode.
- Existing worktree: `existingWorktreePath` takes precedence over `mode`; `existingWorktreeBaseBranch` is needed when that worktree is detached.

The wire enum contains only `"direct"` and `"worktree"` (`packages/contracts/src/models/enums.ts:17-19`). Existing-worktree placement uses optional fields instead of a third mode (`packages/contracts/src/ws/methods.ts:153-157`).

`AgentService.createAttachedExistingWorktreeThread()` verifies the destination workspace, lists its known worktrees, matches a normalized path, rejects unknown paths, and requires a valid base branch for a detached worktree (`apps/server/src/features/agents/orchestration/agent-service.ts:1055-1106`). An agent tool should offer opaque worktree handles from a destination catalog instead of accepting model-authored filesystem paths.

### Turn submission

`AgentService.sendMessage()` is the central turn-submission path (`apps/server/src/features/agents/orchestration/agent-service.ts:477`). An agent-created thread should use this service rather than invoke a provider adapter directly. That preserves current persistence, event mapping, permission, goal, and lifecycle behavior.

The WebSocket router already delegates `thread.create` to `ThreadService` and `agent.send` or `agent.createAndSend` to `AgentService` (`apps/server/src/transport/ws-router.ts:464-473`, `apps/server/src/transport/ws-router.ts:751-765`). The new orchestration layer should call those services, not loop through the WebSocket router.

`AgentService.createAndSend()` is the closest implementation seam. It derives the title from the first message, creates or attaches the requested checkout, persists provider and model settings, and submits the first turn (`apps/server/src/features/agents/orchestration/agent-service.ts:1118-1208`). Its method defaults are Claude, `claude-sonnet-4-6`, direct mode, and `main` (`apps/server/src/features/agents/orchestration/agent-service.ts:1121-1130`).

Those method defaults are not the configured user defaults. The renderer resolves the configured provider and a compatible model from settings before calling the server (`apps/web/src/lib/model-registry.ts:237-286`). The agent capability must perform equivalent resolution on the server when the model omits provider or model.

The Codex adapter starts or resumes an app-server thread and submits work with `turn/start` (`apps/server/src/providers/codex/codex-app-server.ts:880-913`, `apps/server/src/providers/codex/codex-app-server.ts:1163-1238`). Mcode must keep the mapping between its thread ID and the provider’s opaque thread ID inside the provider session layer.

### Existing subagent projection

The Codex event mapper recognizes collaboration tool calls and child-thread notifications. It tracks spawned child thread IDs, associates their tool calls with a parent tool call, and emits nested Mcode agent events (`apps/server/src/providers/codex/codex-event-mapper.ts:50-59`, `apps/server/src/providers/codex/codex-event-mapper.ts:536-727`).

This mechanism intentionally keeps a subagent inside the parent Mcode turn. The domain glossary says subagent calls remain part of the same turn and are linked by `parentToolCallId` (`CONTEXT.md`, “Sub-agent”). Agent-created Mcode threads need a separate relationship field and lifecycle. Reusing `parentToolCallId` would incorrectly make durable child conversations depend on one transient tool call.

### Authentication is not an agent authorization model

The WebSocket server validates the development instance and compares the auth token before admitting a connection (`apps/server/src/transport/ws-server.ts:220-245`). Single-instance attachment also validates the instance token and exact worktree identity (`apps/server/src/transport/ws-server.ts:66-98`).

After admission, the router serves requests under that connection-wide authority. This is appropriate for the trusted Mcode client, but too broad for a provider subprocess. Mcode must not give the model the WebSocket token or let it choose arbitrary thread IDs.

## Provider capabilities

Codex app-server exposes the primitives needed for its own conversation lifecycle:

- `thread/start` creates a fresh conversation and subscribes the caller to its events.
- `thread/resume` loads a stored thread.
- `thread/fork` creates a distinct thread from stored history.
- `turn/start` appends a user turn.
- `turn/steer` adds input to an active turn while checking the expected turn ID.
- `turn/interrupt` interrupts an active turn.
- `thread/inject_items` inserts raw model-visible history without starting a user turn.

Source: [Codex app-server threads](https://learn.chatgpt.com/docs/app-server#threads) and [turns](https://learn.chatgpt.com/docs/app-server#turns).

App-server also streams `collabToolCall` items with sender, receiver, and new-thread identifiers. Thread listing can filter by parent or ancestor under the experimental API. These fields can improve Codex-specific observability, but Mcode should not make its durable data model depend on an experimental provider hierarchy. Source: [Codex app-server items](https://learn.chatgpt.com/docs/app-server#items).

Codex subagents inherit the parent sandbox and permission mode by default. A custom agent may override its sandbox. Source: [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents).

Approvals are server-initiated requests scoped to a provider thread and turn. The client must answer the request, then wait for authoritative resolution and item completion. Mcode therefore needs to route a child approval to the child Mcode thread even when the parent agent initiated the work. Source: [Codex app-server approvals](https://learn.chatgpt.com/docs/app-server#approvals).

## What to reuse from OpenAI Codex

The OpenAI Codex source separates tool definitions, thread control, concurrency guards, status, and protocol presentation. Mcode should reuse the shape of that separation, not copy Codex's provider-owned child threads.

Reusable ideas:

- A tool registry defines strict model-facing schemas independently from handlers. Codex builds its registry in [`codex-rs/core/src/tools/spec.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/spec.rs).
- Agent control owns spawn slots and lifecycle rather than leaving them to individual tool handlers. The primary implementation is [`codex-rs/core/src/agent/control.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/agent/control.rs).
- Separate multi-agent handlers implement spawn, input, wait, and close under [`codex-rs/core/src/tools/handlers/multi_agents/`](https://github.com/openai/codex/tree/main/codex-rs/core/src/tools/handlers/multi_agents).
- App-server exposes threads and turns as protocol resources, including list/read, parent filtering, steering, interruption, and streamed terminal status. See [`codex-rs/app-server/README.md`](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md).
- Codex limits recursive and concurrent spawning and can remove collaboration tools at the depth boundary. Mcode needs the same fail-closed behavior at tool registration and execution time.

Unsuitable parts:

- Codex children are provider sessions under `AgentControl`. Mcode children must be normal Mcode thread records so they work across providers and appear in the workspace roster.
- Codex's child hierarchy does not create or own Mcode worktrees, issue metadata, or Mcode permission policy.
- `parentThreadId` in app-server describes a Codex spawn edge. It cannot replace a durable Mcode relationship because provider session IDs are opaque and provider-specific.
- Codex collaboration tools operate inside one provider runtime. The epic use case needs Mcode to coordinate several provider runtimes and isolated repository worktrees.
- App-server's experimental parent and ancestor filters are useful telemetry, but they are not a stable persistence contract for Mcode.

## What to reuse from Synara

Synara implements two MCP surfaces for this problem. Its internal `/mcp` endpoint is injected into a running provider session. Its external MCP integration lets a separately paired Codex, Claude, or other local client create and follow Synara work. These surfaces share creation machinery but expose different authority and lifecycle contracts. Source: [Synara external MCP guide](https://github.com/Emanuele-web04/synara/blob/3f66f8ee5b1e5d8aa682029b31b4b89b797a5e7f/docs/external-mcp.md).

### Internal provider-session contract

The internal `synara_create_threads` tool creates an exact batch of 1 to 20 standalone threads. Each item contains `prompt`, `target`, and optional `projectId`, `title`, `environment`, `baseRef`, and `runtimeMode`. The batch has a stable `requestId`. The singular convenience tool accepts the same core fields. Synara derives the caller thread and turn from the active provider-session context rather than accepting them from the model. Source: [`AgentGateway.ts`](https://github.com/Emanuele-web04/synara/blob/3f66f8ee5b1e5d8aa682029b31b4b89b797a5e7f/apps/server/src/agentGateway/Layers/AgentGateway.ts).

Creation returns an operation ID, the request ID, counts, thread IDs, and one result per thread. Each result includes `threadId`, `projectId`, title, provider target, runtime mode, environment, branch, worktree path, and dispatch status. Durable retries replay the operation; reuse of the request ID with a different plan is rejected. Source: [`creationCoordinator.ts`](https://github.com/Emanuele-web04/synara/blob/3f66f8ee5b1e5d8aa682029b31b4b89b797a5e7f/apps/server/src/agentGateway/creationCoordinator.ts).

The internal read surface includes `synara_list_threads`, `synara_read_thread`, and `synara_wait_for_threads`. Listing can filter by `projectId`, `parentThreadId`, provider, model, derived status, title, creation source, and update window. Waiting accepts 1 to 20 thread IDs, optional pinned run IDs, and a bounded timeout. A timeout reports progress without retrying, replacing, cancelling, or creating work. Source: [`threadReadTools.ts`](https://github.com/Emanuele-web04/synara/blob/3f66f8ee5b1e5d8aa682029b31b4b89b797a5e7f/apps/server/src/agentGateway/threadReadTools.ts).

### External-client contract

The external integration requires the user to select allowed Projects and grant scopes. Its discovery tools return only those Projects and the provider/model catalog for a chosen Project. Creation requires `projectId`, `provider`, `model`, `prompt`, and a stable `requestId`; optional fields select title, local checkout or managed worktree, runtime mode, and base ref. The typed schemas reject excess properties and bound prompt, request ID, read-page, and wait sizes. Source: [`externalMcp.ts`](https://github.com/Emanuele-web04/synara/blob/3f66f8ee5b1e5d8aa682029b31b4b89b797a5e7f/packages/contracts/src/externalMcp.ts).

External access defaults to a managed worktree and approval-required execution. Local-checkout and full-access execution need independent explicit scopes. Reading normally covers only tasks created by that integration; `tasks:read-project` expands reads to other threads inside an allowed Project. Credentials are revocable, scoped to a fixed audience, checked again during long operations, and kept out of MCP client configuration. Source: [`ExternalMcpGateway.ts`](https://github.com/Emanuele-web04/synara/blob/3f66f8ee5b1e5d8aa682029b31b4b89b797a5e7f/apps/server/src/externalMcp/Layers/ExternalMcpGateway.ts) and [`ExternalMcpService.ts`](https://github.com/Emanuele-web04/synara/blob/3f66f8ee5b1e5d8aa682029b31b4b89b797a5e7f/apps/server/src/externalMcp/Layers/ExternalMcpService.ts).

Synara's external first version exposes create, read, and wait, but no send, steer, interrupt, stop, or general thread-list tool. Its internal surface lists and waits for threads, but creation starts standalone work rather than defining a general ongoing parent-to-child messaging protocol. Mcode therefore still needs `thread_send` and `thread_interrupt` for the user's stated requirement to continue interacting with created threads.

### Contract implications for Mcode

Reuse these patterns:

- Distinguish an in-thread agent capability from a separately paired external MCP integration.
- Derive creator thread, creator turn, and authorization from the authenticated session.
- Require an explicit destination Project for cross-Project work, while allowing the internal tool to default to the caller's Project when omitted.
- Return the created thread ID and resolved Project, provider, placement, and run state.
- Support exact batch creation for epic fan-out instead of forcing many unrelated single-create calls.
- Keep transport replay protection inside the server or MCP bridge rather than requiring the model to manage request IDs.
- Separate Project discovery, provider/model discovery, creation, bounded reads, and bounded waits.
- Pin waits to run IDs so a later turn does not change the meaning of an outstanding wait.
- Grant local-checkout and full-access execution separately from ordinary isolated-worktree creation.

Do not copy these constraints:

- Requiring `provider` and `model` conflicts with the settled Mcode behavior. Mcode should resolve omitted values from the user's defaults, then return the resolved target. When the user specifies either value, Mcode must use that exact value or return an error instead of silently substituting another target.
- Returning a model-visible filesystem path is unnecessary for Mcode's contract. Prefer opaque Project and worktree IDs; retain canonical paths inside the server boundary.
- Synara's external ownership rule is integration-centric. An agent running inside Mcode needs caller-derived lineage plus user access, not a separate external integration identity.
- Synara's external lifecycle is observation-only after creation. Mcode needs explicit follow-up messaging and interruption.

## Current Mcode provenance and approval facts

Mcode's persisted message contract distinguishes only `user`, `assistant`, and `system` roles. A message stores its thread, content, sequence, optional model, and related presentation metadata, but it does not store the provider that authored it, whether a `user`-role message came from a human or another agent, or the source thread and turn (`packages/contracts/src/models/message.ts:8-39`). The message repository writes the same row shape and has no author-provenance fields (`apps/server/src/repositories/message-repo.ts:220-247`).

Provider identity currently belongs to the thread. The thread record stores one active `provider` and `model`, along with the last interaction and permission modes (`packages/contracts/src/models/thread.ts:34-49`). A send may override `provider` and `model`, and the server broadcasts the newly persisted active provider and model through `thread.modelUpdated` (`packages/contracts/src/ws/methods.ts:89-109`; `packages/contracts/src/ws/channels.ts:46-51`). Consequently, the thread provider cannot reliably identify who submitted a particular inbound message.

The chat renderer branches directly on `message.role`: `user` messages use the right-aligned user bubble, while assistant messages use the assistant path. It has no provider or agent-sender branch (`apps/web/src/components/chat/MessageBubble.tsx:557-601`; `apps/web/src/components/chat/MessageBubble.tsx:735-744`). Provider icons already exist and are mapped for thread rows; the sidebar derives the icon from `thread.provider` (`apps/web/src/components/sidebar/ProjectTree.tsx:990-1001`; `apps/web/src/components/sidebar/ProjectTree.tsx:1268-1327`). Reusing those icons for an agent-authored inbound message therefore requires durable per-message provenance rather than reading the destination thread's provider.

The current permission contract contains `requestId`, owning `threadId`, tool name, input, and optional title. It does not record who may decide, who decided, or the deciding thread/provider (`packages/contracts/src/models/permission.ts:14-24`). `permission.respond` accepts only `requestId` and a decision (`packages/contracts/src/ws/methods.ts:593-603`). The WebSocket router forwards that pair to `AgentService`, which searches all providers and lets the first provider holding the request ID resolve it (`apps/server/src/transport/ws-router.ts:1398-1405`; `apps/server/src/features/agents/orchestration/agent-service.ts:1864-1885`). Provider implementations unblock the owning provider session and emit a resolution event containing only request ID and decision (`apps/server/src/providers/codex/codex-provider.ts:1620-1636`; `apps/server/src/providers/claude/claude-provider.ts:2623-2641`). There is therefore no current authorization or audit distinction between a human response, the requesting agent approving itself, or another thread responding.

These facts imply two missing durable contracts for cross-thread operation:

- inbound message provenance that can distinguish a composer submission from a cross-thread submission and identify the source thread, source turn, and source provider
- approval resolution provenance and authorization that can identify the deciding actor and enforce which thread or user is allowed to resolve an owning thread's request

They do not require changing the transcript role consumed by providers. An agent-authored instruction may remain a provider-facing user turn while carrying separate origin metadata for persistence, audit, and UI presentation.

## Example: epic coordination

One useful workflow is an epic coordinator:

1. The parent agent reads an epic and determines which child issues are eligible.
2. It creates one Mcode thread and one isolated worktree for each eligible issue.
3. It names each thread with the issue number and a short title.
4. It sends the issue-scoped assignment to that child.
5. It observes progress, answers questions, steers or interrupts work, and waits for terminal outcomes.
6. It preserves dependency order so blocked issues do not start early.

That workflow may later benefit from stronger semantics than a generic `spawn_agent` clone:

- an issue or other external reference
- explicit dependency and blocked state
- one active child per issue and worktree
- worktree provisioning status separate from agent turn status
- a durable coordination result that survives parent turn completion and app restart

Issue metadata and duplicate-issue policy are deferred extensions. They are not part of the initial cross-Project thread contract.

## Decisions from product grilling

- The user and coordinator thread share control of delegated threads.
- When the coordinator omits a provider, Mcode uses the user's default provider.
- The initial example creates isolated worktree threads for eligible child issues in an epic.
- The internal capability lets any thread create another normal thread in any registered Project and checkout placement.
- Build the internal thread-to-thread MCP first. A separately paired external MCP reuses the same service through a stricter authority context.
- One creation request may create between one and twenty threads across different Projects.
- Every created thread requires an explicit destination `workspaceId`.
- Only `providerId` and `modelId` are optional target selectors. Omitted selectors resolve from the user's defaults; specified selectors must match exactly.
- The initial lifecycle includes create, list, read, wait, send, and stop operations.
- Build is the default interaction mode. Plan is an explicit per-turn choice.
- Every cross-thread message records a thread origin with the source thread, source turn, and source provider. Composer submissions record a composer origin. The UI may render the recorded provider icon but must not infer origin from the destination thread.
- Internal agents can search the user's registered Projects and resolve a result to its opaque `workspaceId` before creating a thread.
- Project search covers registered Project names and repository identities, never arbitrary filesystem directories.
- An empty Project search returns a bounded list of recently used registered Projects.
- Every Project search result includes its `workspaceId`; ambiguous matches remain separate results and require explicit selection.
- In the first release, agents may observe approval-blocked threads, but only the user may resolve approval requests.
- `workspaceId` is the code-level Project identifier. Successful results and errors concerning a Workspace known under the caller's authority include it. Normalized errors for unknown, unauthorized, or unselected targets omit it.
- Internal agents can search, read, message, wait for, and stop existing threads in any registered Project, not only threads they created. Every operation excludes the source thread.
- External integrations can operate only within selected Workspaces and granted scopes. Ownership rules may further restrict reads and mutations to threads created by that integration.
- Omitted permission mode resolves from the user's configured default. A user who prefers Full can make Full the default rather than hard-coding it into orchestration.
- Thread creation returns the created thread summary and initial-turn status, not timeline feed items.
- Semantic retries remain the agent's decision based on structured errors. The public contract does not require a model-managed retry or idempotency key.

## Package boundary

The feature deserves a dedicated package-level domain module, but not a standalone application or mini-project.

Recommended layout:

- `packages/contracts`: wire schemas and public event types only
- `packages/thread-orchestration`: provider-neutral state machine, capability policy, replay protection, lineage types, and pure transition logic
- `apps/server`: `ThreadControlService`, persistence adapters, worktree provisioning, `ThreadService` and `AgentService` calls, and event publication
- provider adapters: thin tool exposure and result translation
- `apps/web`: roster, parent delegation item, approval routing, and child navigation

A package is justified because the state machine and authorization contracts cross server, provider, and renderer boundaries and need focused tests without importing server infrastructure. A separate process would add recovery and authentication complexity without creating a useful isolation boundary. Keep one server authority and one database transaction boundary.

The package should expose deep, narrow interfaces:

```ts
type InternalAuthority = {
  type: "internal";
  userId: string;
  sourceThreadId: string;
  sourceTurnId: string;
  sourceToolCallId: string;
  sourceProviderId: string;
  permissionMode: "supervised" | "full";
};

type ExternalScope =
  | "projects:read"
  | "worktrees:read"
  | "threads:create"
  | "threads:read-owned"
  | "threads:read-project"
  | "threads:send-owned"
  | "threads:send-project"
  | "threads:stop-owned"
  | "threads:stop-project"
  | "worktrees:create"
  | "execution:full";

type ExternalAuthority = {
  type: "external";
  integrationId: string;
  allowedWorkspaceIds: readonly string[];
  scopes: readonly ExternalScope[];
  limits: {
    callsPerMinute: number;
    maxActiveThreads: number;
  };
};

type ThreadControlAuthority = InternalAuthority | ExternalAuthority;

type CreateThreadCommand = {
  workspaceId: string;
  title: string;
  task: string;
  placement: ThreadPlacement;
  providerId?: string;
  modelId?: string;
  permissionMode?: "supervised" | "full";
  interactionMode?: "build" | "plan";
};
```

Each MCP boundary authenticates its caller and constructs a `ThreadControlAuthority`. The model never supplies it. An internal provider-session MCP constructs `InternalAuthority` from the active Mcode user, thread, turn, tool call, provider, and permission mode. A paired external MCP constructs `ExternalAuthority` from the integration registration and its current grants.

Both boundaries call one `ThreadControlService`. The service, not the MCP adapter, enforces authority on every search, read, create, send, stop, and wait operation. This prevents another server caller from bypassing policy by invoking the service directly.

Internal and external tool policy differs:

| Operation              | Internal provider-session MCP                                                     | Paired external MCP                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Search Projects        | All Projects registered for the current user                                      | Only `allowedWorkspaceIds` with `projects:read`                                                                      |
| List worktrees         | Any registered Project                                                            | Allowed Project with `worktrees:read`                                                                                |
| Create threads         | Any registered Project                                                            | Allowed Project with `threads:create`; new worktrees also require `worktrees:create`                                 |
| Search or read threads | Any other thread in registered Projects                                           | Integration-owned threads with `threads:read-owned`, or Project threads with `threads:read-project`                  |
| Send to threads        | Any other thread; Full runs directly, Supervised returns a human approval request | Integration-owned threads with `threads:send-owned`, or any thread in an allowed Project with `threads:send-project` |
| Stop threads           | Any other thread; Full runs directly, Supervised returns a human approval request | Integration-owned threads with `threads:stop-owned`, or any thread in an allowed Project with `threads:stop-project` |
| Wait for threads       | Any other thread                                                                  | Only threads the integration may read                                                                                |

The internal MCP has no per-Workspace or per-thread allowlists. The source thread is always excluded from discovery and every target operation to prevent recursive self-control. The external MCP applies selected Workspace IDs, operation scopes, integration ownership, rate limits, and active-thread limits. Full and Supervised remain execution policies for internal mutations; they do not replace external scopes.

Caller-derived fields must not appear in the model tool schema:

- creator thread, turn, and tool-call IDs
- authenticated runtime identity
- external Workspace and scope grants
- depth, concurrency, budget, and wait limits
- audit actor and transport replay namespace

The model may supply:

- a destination Workspace handle selected from an authorized Project catalog
- title and initial task
- direct, new-worktree, or existing-worktree placement
- base ref or branch name for a new worktree
- an existing worktree handle selected from the destination catalog
- provider, model, permission, and reasoning settings within the capability bounds

The server resolves omitted provider and model from user settings. For an internal caller, omitted permission mode also resolves from the user's configured default. For an external caller, omitted permission mode resolves to Supervised unless the integration holds `execution:full`; with that scope, it may resolve to the user's configured default. An explicit Full request without `execution:full` returns `forbidden`. The server then applies the caller's authority, resolves handles to IDs and canonical paths, validates the base ref in the destination repository, and constructs the full `CreateAndSendCommand`. Build is the default interaction mode. Plan is opt-in.

## Draft contract evaluated during research

This section preserves the contract used to test the design scenarios during
research. The accepted, implementation-ready source is the
[Agent Thread Control Contract](../specs/2026-07-25-agent-thread-control-contract.md).
Where a draft shape below differs from that specification, the specification
wins.

All IDs are opaque. The model never receives or submits a raw filesystem path. Successful results and errors concerning a Project known under the caller's authority include its `workspaceId`. Normalized errors for unknown, unauthorized, or unselected targets omit it.

```ts
type OrchestrationError = {
  code:
    | "forbidden"
    | "not_found"
    | "invalid_provider"
    | "invalid_model"
    | "invalid_placement"
    | "thread_busy"
    | "approval_required"
    | "limit_exceeded"
    | "conflict"
    | "invalid_request";
  message: string;
  retryable: boolean;
};

type ThreadPlacement =
  | { type: "direct" }
  | { type: "new_worktree"; baseRef: string; branchName?: string }
  | { type: "existing_worktree"; worktreeId: string };

type MessageOrigin =
  | { type: "composer" }
  | { type: "thread"; threadId: string; turnId: string; providerId: string };

type InboundMessageOrigin = MessageOrigin | { type: "legacy" };
```

`workspace_search` searches only registered Project names and repository identities:

```ts
type WorkspaceSearchInput = { query?: string; limit?: number };
type WorkspaceSearchResult = {
  workspaces: Array<{
    workspaceId: string;
    name: string;
    repositoryIdentity?: string;
    lastUsedAt?: string;
  }>;
};
type WorktreeListInput = { workspaceId: string };
type WorktreeListResult = {
  workspaceId: string;
  worktrees: Array<{ worktreeId: string; label: string; branch?: string }>;
};
```

The server bounds `limit`. For internal callers, an empty query returns recently used registered Projects. For external callers, both search and recent results are restricted to `allowedWorkspaceIds` and `projects:read`. Ambiguous names remain separate entries, each with a `workspaceId`.

`thread_create_batch` creates and starts one to twenty threads:

```ts
type CreateThreadInput = {
  workspaceId: string;
  title: string;
  prompt: string;
  placement: ThreadPlacement;
  providerId?: string;
  modelId?: string;
  permissionMode?: "supervised" | "full";
  interactionMode?: "build" | "plan";
};

type CreateThreadResult =
  | {
      status: "created";
      workspaceId: string;
      threadId: string;
      turnId: string;
      runStatus: "starting" | "running" | "failed";
      providerId: string;
      modelId: string;
      permissionMode: "supervised" | "full";
      interactionMode: "build" | "plan";
      worktreeId?: string;
    }
  | {
      status: "pending_approval";
      workspaceId: string;
      threadId: string;
      approvalId: string;
      runStatus: "waiting_for_approval";
      providerId: string;
      modelId: string;
      permissionMode: "supervised" | "full";
      interactionMode: "build" | "plan";
    }
  | {
      status: "failed";
      workspaceId: string;
      threadId: string;
      error: OrchestrationError;
    }
  | { status: "rejected"; workspaceId?: string; error: OrchestrationError };

type ThreadCreateBatchResult = { results: CreateThreadResult[] };
```

Each item succeeds or fails independently. Successful items remain active when another item fails. `rejected` means validation or authorization failed before thread persistence. A rejected result includes `workspaceId` only when the caller's authority permits it to know that Workspace. `failed` identifies a visible persisted thread whose provisioning or dispatch failed. A new-worktree item that needs approval first persists a visible pending thread, then returns `pending_approval` with the approval request's opaque `approvalId` before any repository mutation. It has no `turnId` because dispatch has not begun. Human approval of that `approvalId` resumes the same pending operation. Mcode provisions the worktree, starts the initial turn, and then publishes a `created` result with `turnId`. Rejection of the approval or provisioning failure leaves the thread visible with a terminal failure. The result contains no timeline feed items. Omitted provider and model resolve from the user's configured defaults. Internal permission defaults follow the user's setting. External permission defaults follow the `execution:full` rule above. Explicit provider, model, permission, and interaction values must be honored exactly or rejected. `ThreadControlService` applies the caller's internal or external authority before persistence or mutation.

For an external batch, `ThreadControlService` reserves per-integration capacity atomically before persisting any thread. The active set is `starting`, `running`, `waiting_for_approval`, and `waiting_for_user`. Under one lock or transaction, the service counts that set, reserves the remaining slots for valid inputs in request order, and rejects the unreserved remainder with `limit_exceeded` and `retryable: true`. Successful reserved items stay active if later items fail. Releasing a slot after a thread leaves the active set makes a later intentional call eligible to try again. This prevents concurrent batches from exceeding `maxActiveThreads` while preserving partial batch success.

The public contract has no `requestId` or semantic retry mechanism. Structured errors give the model enough information to decide whether to retry. The server or MCP transport may suppress replay of the same delivery internally, but that mechanism is invisible to the model and must not merge two intentional calls.

The remaining tools use these minimal inputs and discriminated results:

```ts
type ThreadSearchInput = {
  workspaceId: string;
  query?: string;
  status?: Array<"idle" | "running" | "waiting_for_approval" | "failed">;
  limit?: number;
};
type ThreadRef = {
  workspaceId: string;
  threadId: string;
  title: string;
  providerId: string;
  modelId: string;
  updatedAt: string;
} & ThreadObservedState;
type ThreadSearchResult = { workspaceId: string; threads: ThreadRef[] };
type ThreadGetInput = { threadId: string; messageLimit?: number };
type ThreadGetResult =
  | {
      status: "found";
      workspaceId: string;
      thread: ThreadRef;
      messages: ThreadReadMessage[];
    }
  | {
      status: "rejected";
      workspaceId?: string;
      threadId: string;
      error: OrchestrationError;
    };
type ThreadReadMessage =
  | {
      messageId: string;
      role: "user";
      content: string;
      origin: InboundMessageOrigin;
    }
  | {
      messageId: string;
      role: "assistant";
      content: string;
      providerId: string;
      modelId: string;
    }
  | { messageId: string; role: "system"; content: string };
type ThreadSendInput = {
  threadId: string;
  message: string;
  interactionMode?: "build" | "plan";
  permissionMode?: "supervised" | "full";
};
type ThreadStopInput = { threadId: string };
type ThreadWaitInput = {
  threadIds: string[];
  until?: "attention_or_terminal" | "terminal";
  timeoutSeconds: number;
};

type ThreadActionResult =
  | {
      status: "accepted";
      workspaceId: string;
      threadId: string;
      turnId?: string;
    }
  | {
      status: "pending_approval";
      workspaceId: string;
      threadId: string;
      approvalId: string;
    }
  | {
      status: "rejected";
      workspaceId?: string;
      threadId: string;
      error: OrchestrationError;
    };

type ThreadObservedStatus =
  | "starting"
  | "running"
  | "idle"
  | "completed"
  | "failed"
  | "stopped"
  | "waiting_for_approval"
  | "waiting_for_user";

type ThreadObservedState =
  | {
      status: "waiting_for_approval";
      approvalId: string;
    }
  | {
      status: Exclude<ThreadObservedStatus, "waiting_for_approval">;
    };

type ThreadWaitItem = ThreadObservedState & {
  workspaceId: string;
  threadId: string;
};
type ThreadWaitResponse =
  | {
      status: "success";
      timedOut: boolean;
      results: ThreadWaitItem[];
    }
  | {
      status: "rejected";
      error: OrchestrationError;
    };
```

`thread_send` and `thread_stop` both return `ThreadActionResult`. A Supervised internal mutation returns `pending_approval` with an opaque `approvalId`; the agent may observe the target with `thread_get` or `thread_wait`, but only the user may resolve the request. A `ThreadRef` or `ThreadWaitItem` in `waiting_for_approval` includes the same `approvalId`, which lets the caller correlate the original action with later observation. Other statuses omit it. Approval resumes the same action rather than requiring a duplicate send or stop.

`thread_wait` returns `ThreadWaitResponse`. Omitted `until` means `attention_or_terminal`. That boundary wakes for `waiting_for_approval`, `waiting_for_user`, `completed`, `failed`, or `stopped`. The `terminal` boundary wakes only for `completed`, `failed`, or `stopped`. The wait completes when every requested thread reaches the selected boundary or the timeout expires. `ThreadWaitItem.status` is always the authoritative observed state. `timedOut` reports only whether the deadline elapsed first. A timeout never replaces status, cancels work, retries an action, or creates work. Invalid arrays, limits, boundaries, or timeouts return a rejected response with `invalid_request`.

Thread-targeting tools do not reveal existence through rejection details. For an external caller, an unknown thread and a thread outside its readable or mutable scope both return `not_found`. The same rule covers the internal source thread, an unreadable thread, and an unknown thread. A rejection omits `workspaceId` unless the caller already has authority to know that Workspace. `thread_wait` rejects the whole request without partial results when any target fails this check. These normalized responses apply to `thread_get`, `thread_send`, `thread_stop`, and `thread_wait`.

For internal callers, `thread_search` and `thread_get` may cover any existing thread except the source thread. They are not limited to descendants or threads created by the caller. `thread_send`, `thread_stop`, and `thread_wait` apply the same source-thread exclusion. Full mode performs internal mutations directly. Supervised mode routes internal mutations to human approval.

For external callers, Project allowlists and operation scopes apply to every tool. `threads:read-owned` covers threads created by that integration. `threads:read-project` expands reads to other threads in an allowed Project. `threads:send-owned` and `threads:stop-owned` cover only integration-owned threads. `threads:send-project` and `threads:stop-project` expand those mutations to any thread in an allowed Project. `ThreadControlService` checks these rules even when a caller bypasses the MCP adapter.

Mcode derives cross-thread message provenance from the authenticated source session. The model submits only the target and message. New composer messages persist `{ type: "composer" }`. New cross-thread messages persist `{ type: "thread", threadId, turnId, providerId }`. Reads expose `{ type: "legacy" }` only for user-role rows created before provenance existed. New writes cannot use the legacy variant. Assistant rows persist their own `providerId` and `modelId`. The recorded identities remain historical even if either thread later switches providers.

New-worktree creation has two separate checks. First, the caller's internal or external authority must permit creation in that Project and placement. Second, repository mutation may require a human approval under server policy. Mcode persists the pending thread before asking for approval, and it performs no repository mutation or turn dispatch while approval is unresolved. Version one lets agents observe the resumable `waiting_for_approval` state, but only a human may resolve it. Approval resumes the original operation. Rejection records a terminal failure on the visible thread. An agent cannot approve its own or another thread's request.

### Security counterexamples

The authority rules must reject these calls:

- An external integration selected for Project A uses `threads:read-owned` to read a user-created thread in Project A. Return the same `not_found` response used for an unknown thread, without `workspaceId`.
- An external integration selected for Project A targets a thread in Project B, even if it holds the required operation scope. Return normalized `not_found` without `workspaceId`.
- An external integration without `execution:full` explicitly requests Full. The result is `forbidden`; omission resolves to Supervised.
- An external integration with `threads:send-owned` or `threads:stop-owned` targets a thread it did not create. Project-wide mutation requires the corresponding `threads:send-project` or `threads:stop-project` scope.
- Two external batches race for the final active slot. Atomic reservation accepts at most one item and returns retryable `limit_exceeded` for the unreserved remainder.
- A Supervised internal caller sends to or stops another thread and then attempts to resolve its own approval. The mutation remains `pending_approval` until a human resolves it.
- Any internal caller searches for, reads, sends to, waits for, or stops its own source thread. Targeted operations return the same `not_found` response used for an unknown thread. Search excludes it.

### Scenario matrix

| Scenario                                                                                    | Expected outcome                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Search an exact Project name                                                             | Return matching authorized registered Projects. An empty query returns a bounded recent list.                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2. Search an ambiguous Project name                                                         | Return every authorized match separately. Every match includes `workspaceId`.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 3. Create one direct thread in another Project with provider, model, and permission omitted | Create in the supplied `workspaceId`. Resolve provider and model from user defaults. Internal permission uses the user default. External permission uses Supervised unless `execution:full` permits the user default. Return all resolved values.                                                                                                                                                                                                                                                    |
| 4. Create a new worktree with exact provider and model                                      | Use both exact values. Reject an unavailable or disallowed value without substitution. If mutation needs approval, persist and return a visible pending thread without `turnId`, then resume that thread after human approval.                                                                                                                                                                                                                                                                       |
| 5. Create in an existing worktree                                                           | Accept only an authorized opaque `worktreeId` that belongs to `workspaceId`; reject raw or mismatched paths.                                                                                                                                                                                                                                                                                                                                                                                         |
| 6. Create a batch across Projects with one invalid item or insufficient external capacity   | Reserve external active capacity atomically. Keep successful reserved threads and return one result per item. Reject the invalid item normally and any unreserved remainder with retryable `limit_exceeded`. Include `workspaceId` on successes and only on failures where the caller may know that Workspace.                                                                                                                                                                                       |
| 7. Start in Plan, then send a Build follow-up                                               | First turn uses Plan. The later accepted send uses Build. Omission on creation or send resolves to Build.                                                                                                                                                                                                                                                                                                                                                                                            |
| 8. Search and read an unrelated existing thread                                             | Internal: allow any thread in a registered Project except the source thread; do not require creator lineage. External: allow integration-owned threads with `threads:read-owned`, or other Project threads only with `threads:read-project` in an allowed Workspace. Normalize a source, unreadable, unauthorized, unselected, or unknown target to `not_found` without `workspaceId`.                                                                                                               |
| 9. Send a cross-thread message                                                              | Persist thread origin from the authenticated source turn and provider. Internal Supervised returns `pending_approval`; external send requires `threads:send-owned` or `threads:send-project`. Reads require origin on user rows, use explicit `legacy` origin for old rows, and return provider and model on assistant rows.                                                                                                                                                                         |
| 10. Stop an existing thread under Full or Supervised execution                              | Internal Full stops another thread directly. Internal Supervised returns `pending_approval` with `approvalId`. Normalize the source thread to `not_found` without `workspaceId`. External stop requires `threads:stop-owned` or `threads:stop-project` in an allowed Workspace and normalizes unauthorized, unselected, or unknown targets to the same response.                                                                                                                                     |
| 11. Encounter an approval request                                                           | Return `pending_approval` with `workspaceId`, `threadId`, and the exact opaque `approvalId` persisted for that request. Every later `waiting_for_approval` observation requires that same `approvalId`; every other observed status omits it. Only a human may resolve it. For new-worktree creation, persist the pending thread before repository mutation and omit `turnId` until dispatch begins.                                                                                                 |
| 12. Receive the same transport delivery twice                                               | Suppress accidental transport replay internally. Expose no public `requestId`; a later intentional model call remains distinct.                                                                                                                                                                                                                                                                                                                                                                      |
| 13. Wait with no `until`, then reach attention, timeout, or invalid input                   | Default to `attention_or_terminal`. Wake when every target needs attention or is terminal. A `waiting_for_approval` item requires `approvalId`; every other item omits it. On timeout, return successful `timedOut: true` and preserve each authoritative status. Reject malformed input with `invalid_request`. Reject the whole wait with normalized `not_found`, no `workspaceId`, and no partial results when any target is the source thread, unreadable, unauthorized, unselected, or unknown. |
| 14. Source thread switches provider after sending                                           | Keep the original message's recorded provider identity and icon. Do not infer it from the source or destination thread's current provider.                                                                                                                                                                                                                                                                                                                                                           |

## Recommended architecture

Record the dual-surface authority boundary as an ADR before implementation. This research note proposes the decision but does not create or approve that ADR.

### 1. Add a durable relationship

Add a nullable relationship from a child Mcode thread to its creator:

- `parent_thread_id`
- `created_by_turn_id`
- `created_by_tool_call_id`
- `creation_kind`, initially `delegation`

Keep this separate from conversation forks. A fork inherits conversation context from an anchor and currently rejects cross-workspace creation (`apps/server/src/features/agents/orchestration/agent-service.ts:1309-1324`). A created thread starts with an explicit task and may target any authorized workspace. Cross-workspace creation is a new-thread operation, not a relaxation of fork rules.

### 2. Put orchestration behind a server capability

Expose provider-neutral orchestration commands through the same tool bridge used for other Mcode-owned capabilities. The server must derive the caller’s thread and turn from the authenticated provider session. It must not accept an arbitrary parent ID supplied by the model.

The command handler should call `ThreadService` and `AgentService`. This keeps validation, persistence, event publication, cancellation, and provider selection in their existing authorities.

### 3. Separate creation from execution

`thread_create_batch` should persist each accepted thread before submitting its initial task. A new-worktree item that needs approval must persist its pending thread before repository mutation. If later provisioning or task submission fails, the thread remains visible with a failed state instead of disappearing.

Creation input should be bounded:

- title or task text length
- allowed provider and model
- allowed destination workspace and checkout placement
- maximum active children per parent turn and workspace
- no arbitrary filesystem path

The server should resolve workspace and worktree handles to canonical paths. An internal model may choose among registered Projects and their known worktrees. An external integration may choose only allowed Projects and needs `worktrees:create` for new-worktree placement. Server policy may also require human approval because the operation mutates repository state.

### 4. Define message semantics

When a child is idle, `thread_send` starts a normal new turn. When a child is running, Mcode must choose one of two explicit behaviors:

- steer the active turn when the provider supports it, or
- reject the message with a structured `thread_busy` result.

Do not queue silently. Hidden queues make ordering and user intervention difficult to reason about.

### 5. Project state in both places

The parent timeline should show a durable delegation item with child title, status, unread activity, and a link to open the child. The child remains a normal sidebar thread with its full transcript and controls.

Status should distinguish:

- queued or starting
- running
- waiting for approval
- waiting for user input
- completed
- failed
- interrupted

The parent item may summarize the child result, but the child transcript remains authoritative.

### 6. Enforce trust boundaries

The server should:

- authorize every action against the caller's authenticated source session
- derive internal authority from the authenticated source session without per-thread or per-Workspace grants
- constrain external access with selected Workspaces, ownership-aware scopes, and atomic per-integration capacity
- resolve internal omitted permission mode from the user's configured default
- clamp external omitted permission mode to Supervised unless `execution:full` permits the user default
- reject an explicit external Full request without `execution:full`
- require human approval when server policy requires it
- route approval prompts to the owning child thread and also signal the parent
- cap child count, nesting depth, message size, wait duration, and returned transcript size
- cancel waits when the parent turn ends or disconnects
- log creator, target, action, and outcome without logging secrets or full prompts

Provider processes should receive opaque Mcode thread handles, not database IDs or filesystem paths.

## Delivery slices

### Slice 1: discovery and visible created thread

Add the relationship schema, `workspace_search`, worktree catalog, `thread_create_batch`, `thread_get`, and `thread_wait`. Support authorized destination Workspaces and all three checkout placements. Persist pending new-worktree threads before approval or repository mutation, then resume them after human approval. Resolve user defaults under the capability ceiling. Show pending and created threads in the destination Project's sidebar and the source timeline.

### Slice 2: ongoing interaction

Add `thread_search`, `thread_send`, `thread_stop`, attention-required states, approval routing, provenance, and user/agent collision rules. Apply internal session authority and external ownership-aware scopes to both created and existing threads.

### Slice 3: lifecycle hardening

Add conversation forks, deeper nesting, richer audit views, and recovery across app restarts. Validate the contracts with a UI prototype before committing the final timeline and message presentation.

## Recorded lifecycle decisions

- Agent-created conversations are normal Mcode threads with creator lineage.
- User and agent sends use an atomic per-thread gate. The first accepted send starts; another send receives `thread_busy`.
- Running destinations reject follow-up messages in the first release. Mcode does not steer or queue them.
- Created threads continue independently when the source turn completes, stops, or disconnects.
- Active waits end when the source turn stops or disconnects.
- Deleting the source thread does not delete created threads.
- The source explicitly calls `thread_wait`; completion does not resume it automatically.
- Only the human user resolves approvals in the first release.
- ADR 0021 records the authority and lifecycle boundary.

Cost attribution, provider availability, and final presentation remain later delivery choices. They do not block the core contracts or service implementation.

## Conclusion

Mcode already has the main internal seams: durable thread creation, centralized turn submission, provider session adapters, event persistence, and a Codex subagent projection. The missing piece is a server-owned orchestration boundary plus a durable parent-child relationship.

Treat provider-native child threads as execution details and telemetry. Create normal Mcode threads for user-visible delegated work. This keeps the feature provider-neutral, auditable, and compatible with shared user control.
