# Agent Thread Control Contract

**Date:** 2026-07-25
**Status:** Specification
**Epic:** [#958](https://github.com/Mzeey-Empire/mcode/issues/958)
**Related ADR:** [0021](../adr/0021-thread-control-authority-and-lifecycle.md)

## Purpose

This document is the canonical implementation contract for agent-driven thread
control. It converts the decisions in epic #958 and ADR 0021 into model-facing
inputs, server-owned authority, result unions, lifecycle rules, and delivery
boundaries.

An implementing agent must not infer missing behavior from provider-specific
subagent APIs. A delegated thread is a normal, persisted Mcode Thread in a
destination Workspace. It can use any supported Provider, appears in the
Project's normal thread list, and continues independently of its coordinator.

## User outcome

A user can ask a coordinator thread to:

1. Find registered Projects.
2. Resolve exact `workspaceId` values.
3. List selectable worktrees without exposing filesystem paths.
4. Create one to twenty threads across Projects.
5. Search and read existing threads.
6. Send follow-up work in Build or Plan mode.
7. Stop work.
8. Wait for exact threads to require attention or finish.

The first target workflow is epic coordination. One coordinator finds the
relevant Projects, opens one isolated worktree thread per child issue, includes
the issue number in each title, assigns the work, and monitors the results.

## Architecture

The implementation has four boundaries:

- `packages/contracts` owns wire schemas, exported limits, and public event
  types.
- `packages/thread-orchestration` owns provider-neutral authority types,
  capability policy, state transitions, replay protection, and lineage.
- `apps/server` owns `ThreadControlService`, persistence, approval routing,
  worktree resolution, and calls into existing thread and agent services.
- Internal and external MCP adapters authenticate callers, build server-owned
  authority, translate the wire request, and call `ThreadControlService`.

Both MCP surfaces call the same service. An adapter must not enforce policy as
the only guard, and it must not call provider adapters or repositories directly.

## Server-owned authority

Authority never appears in a model-callable tool schema.

```ts
type InternalThreadControlAuthority = {
  type: "internal";
  userId: string;
  sourceThreadId: string;
  sourceTurnId: string;
  sourceToolCallId: string;
  sourceProviderId: string;
  permissionMode: "supervised" | "full";
};

type ExternalThreadControlScope =
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

type ExternalThreadControlAuthority = {
  type: "external";
  integrationId: string;
  allowedWorkspaceIds: readonly string[];
  scopes: readonly ExternalThreadControlScope[];
  limits: {
    callsPerMinute: number;
    maxActiveThreads: number;
  };
};

type ThreadControlAuthority =
  InternalThreadControlAuthority | ExternalThreadControlAuthority;
```

The internal adapter derives every internal authority field from the active
provider session. The external adapter derives every external field from the
paired integration record. The model cannot submit or override either form.

## Wire limits

The contracts package exports these limits and uses them in every adapter:

| Value                       | Contract                           |
| --------------------------- | ---------------------------------- |
| Opaque ID                   | 1 to 128 characters                |
| Search query                | 0 to 256 characters after trimming |
| Search result limit         | 1 to 50, default 20                |
| Workspace filter            | 1 to 20 IDs when supplied          |
| Batch creation              | 1 to 20 items                      |
| Thread title                | 1 to 256 characters after trimming |
| Prompt or follow-up message | 1 to 100,000 characters            |
| Provider or model ID        | 1 to 128 characters                |
| Git base ref or branch name | 1 to 250 characters                |
| Transcript read             | 1 to 100 messages, default 50      |
| Wait targets                | 1 to 20 unique thread IDs          |
| Wait timeout                | 1 to 1,800 seconds, default 300    |
| Public error message        | 1 to 512 characters                |

The service validates bounds again at its trust boundary. It resolves opaque
IDs to canonical server records and never returns a raw filesystem path.

## Shared types

```ts
type PermissionMode = "supervised" | "full";
type InteractionMode = "build" | "plan";

type ThreadPlacement =
  | { type: "direct" }
  | {
      type: "new_worktree";
      baseRef: string;
      branchName?: string;
    }
  | {
      type: "existing_worktree";
      worktreeId: string;
    };

type ThreadControlErrorCode =
  | "forbidden"
  | "not_found"
  | "invalid_provider"
  | "invalid_model"
  | "invalid_placement"
  | "thread_busy"
  | "limit_exceeded"
  | "conflict"
  | "invalid_request"
  | "internal_error";

type ThreadControlError = {
  code: ThreadControlErrorCode;
  message: string;
  retryable: boolean;
  retryAfterSeconds?: number;
};

type ThreadObservedState =
  | { status: "starting" }
  | { status: "running" }
  | { status: "idle" }
  | { status: "completed" }
  | { status: "failed" }
  | { status: "stopped" }
  | {
      status: "waiting_for_approval";
      approvalId: string;
    }
  | { status: "waiting_for_user" };

type ResolvedExecution = {
  providerId: string;
  modelId: string;
  permissionMode: PermissionMode;
  interactionMode: InteractionMode;
};

type ResolvedPlacement =
  | { type: "direct" }
  | {
      type: "new_worktree";
      baseRef: string;
      branchName?: string;
      worktreeId: string;
    }
  | {
      type: "existing_worktree";
      worktreeId: string;
    };
```

`approval_required` is not an error code. An unresolved approval is a successful
request with `status: "pending_approval"` and a durable `approvalId`.

`not_found` is not retryable unless new authority or external state may make the
target visible. `invalid_request`, `invalid_provider`, `invalid_model`,
`invalid_placement`, and `forbidden` are not retryable without changing the
request or grants. `thread_busy`, `limit_exceeded`, `conflict`, and
`internal_error` may be retryable. The server sets the boolean from the actual
failure and supplies `retryAfterSeconds` only when it has a meaningful delay.

## Tool contracts

### `workspace_search`

Searches Projects already registered in Mcode. It never searches arbitrary
filesystem directories.

```ts
type WorkspaceSearchInput = {
  query?: string;
  limit?: number;
};

type WorkspaceSearchResult = {
  workspaces: Array<{
    workspaceId: string;
    name: string;
    repositoryIdentity?: string;
    lastUsedAt?: string;
  }>;
};
```

An omitted or empty query returns recently used authorized Projects. Ambiguous
matches remain separate. Every result includes `workspaceId`.

Internal callers search all registered Projects. External callers receive only
selected Workspaces and require `projects:read`.

### `worktree_list`

```ts
type WorktreeListInput = {
  workspaceId: string;
};

type WorktreeListResult =
  | {
      status: "found";
      workspaceId: string;
      worktrees: Array<{
        worktreeId: string;
        label: string;
        branch?: string;
        baseRef?: string;
      }>;
    }
  | {
      status: "rejected";
      workspaceId?: string;
      error: ThreadControlError;
    };
```

The result contains opaque `worktreeId` values and display information. It
never contains a path. An existing-worktree placement is valid only when the
selected worktree belongs to the supplied Workspace.

### `thread_create_batch`

```ts
type ThreadCreateInput = {
  workspaceId: string;
  title: string;
  prompt: string;
  placement: ThreadPlacement;
  providerId?: string;
  modelId?: string;
  permissionMode?: PermissionMode;
  interactionMode?: InteractionMode;
};

type ThreadCreateBatchInput = {
  items: ThreadCreateInput[];
};

type ThreadCreateItemResult =
  | {
      index: number;
      status: "created";
      workspaceId: string;
      threadId: string;
      turnId: string;
      execution: ResolvedExecution;
      placement: ResolvedPlacement;
      state: { status: "starting" } | { status: "running" };
    }
  | {
      index: number;
      status: "pending_approval";
      workspaceId: string;
      threadId: string;
      approvalId: string;
      execution: ResolvedExecution;
      requestedPlacement: ThreadPlacement;
      state: {
        status: "waiting_for_approval";
        approvalId: string;
      };
    }
  | {
      index: number;
      status: "failed";
      workspaceId: string;
      threadId: string;
      error: ThreadControlError;
      state: { status: "failed" };
    }
  | {
      index: number;
      status: "rejected";
      workspaceId?: string;
      error: ThreadControlError;
    };

type ThreadCreateBatchResult = {
  results: ThreadCreateItemResult[];
};
```

The result array preserves input order, and `index` is the zero-based input
position assigned by the server. It is not a caller-supplied request ID.

Each item is independent. A rejected item does not roll back accepted items.
`rejected` means validation or authority failed before persistence. `failed`
means a visible thread was persisted before provisioning or dispatch failed.
`created` means persistence and initial dispatch succeeded. It never carries a
failed state and never includes timeline feed items.

For a new worktree that requires approval, Mcode persists a visible pending
thread before requesting approval. It performs no repository mutation and
starts no turn until the human approves. The pending result has no `turnId` or
resolved `worktreeId`. Approval resumes the same operation. Rejection or later
provisioning failure leaves the thread visible with terminal failure state.

Omitted provider and model resolve from user defaults. Explicit values must be
used exactly or the item is rejected. Omitted internal permission mode resolves
from the user's default. Omitted external permission mode resolves to
Supervised unless `execution:full` permits the user's default. An explicit
external Full request without that scope is rejected as `forbidden`.

Build is the omitted interaction default. Plan is explicit.

### `thread_search`

```ts
type ThreadSearchInput = {
  workspaceIds?: string[];
  query?: string;
  statuses?: Array<
    | "starting"
    | "running"
    | "idle"
    | "completed"
    | "failed"
    | "stopped"
    | "waiting_for_approval"
    | "waiting_for_user"
  >;
  limit?: number;
};

type ThreadRef = {
  workspaceId: string;
  threadId: string;
  title: string;
  providerId: string;
  modelId: string;
  createdAt: string;
  updatedAt: string;
  state: ThreadObservedState;
};

type ThreadSearchResult = {
  threads: ThreadRef[];
};
```

An omitted `workspaceIds` filter searches every Workspace the caller may read.
This supports requests such as “read the last ten open threads.” Supplying the
filter narrows the search but never expands authority. Results sort by
`updatedAt` descending, then `threadId` ascending for a stable tie-break.

Internal search covers all registered Projects except the source thread.
External search covers selected Workspaces and requires the appropriate owned
or Project-wide read scope. Every result includes `workspaceId`.

### `thread_get`

```ts
type MessageOrigin =
  | { type: "composer" }
  | {
      type: "thread";
      sourceThreadId: string;
      sourceTurnId: string;
      sourceProviderId: string;
    }
  | { type: "legacy" };

type ThreadReadMessage =
  | {
      messageId: string;
      role: "user";
      content: string;
      createdAt: string;
      origin: MessageOrigin;
    }
  | {
      messageId: string;
      role: "assistant";
      content: string;
      createdAt: string;
      providerId: string;
      modelId: string;
    }
  | {
      messageId: string;
      role: "system";
      content: string;
      createdAt: string;
    };

type ThreadGetInput = {
  threadId: string;
  messageLimit?: number;
};

type ThreadGetResult =
  | {
      status: "found";
      workspaceId: string;
      thread: ThreadRef;
      messages: ThreadReadMessage[];
      hasMoreMessages: boolean;
    }
  | {
      status: "rejected";
      workspaceId?: string;
      threadId: string;
      error: ThreadControlError;
    };
```

Messages are the newest bounded window in chronological order.
`hasMoreMessages` tells the caller whether older rows exist. Version one does
not add cursor pagination to this model-facing read.

New composer rows use `composer`. New cross-thread rows use `thread` provenance
derived from the authenticated source session. Only migrated rows may use
`legacy`. Assistant rows persist the provider and model used when the message
was produced.

### `thread_send`

```ts
type ThreadSendInput = {
  threadId: string;
  message: string;
  interactionMode?: InteractionMode;
  permissionMode?: PermissionMode;
};

type ThreadSendResult =
  | {
      status: "accepted";
      workspaceId: string;
      threadId: string;
      turnId: string;
      execution: ResolvedExecution;
      state: { status: "starting" } | { status: "running" };
    }
  | {
      status: "pending_approval";
      workspaceId: string;
      threadId: string;
      approvalId: string;
      state: {
        status: "waiting_for_approval";
        approvalId: string;
      };
    }
  | {
      status: "rejected";
      workspaceId?: string;
      threadId: string;
      error: ThreadControlError;
    };
```

Build is the omitted interaction default. Permission omission follows the same
internal and external rules as creation. A running destination rejects with
retryable `thread_busy`. Version one does not steer or queue the message.

Every accepted cross-thread message persists the source thread, turn, and
provider from internal authority. The destination displays it as thread-origin
content, not as a composer submission.

### `thread_stop`

```ts
type ThreadStopInput = {
  threadId: string;
};

type ThreadStopResult =
  | {
      status: "accepted";
      workspaceId: string;
      threadId: string;
      state: { status: "stopped" };
    }
  | {
      status: "pending_approval";
      workspaceId: string;
      threadId: string;
      approvalId: string;
      state: {
        status: "waiting_for_approval";
        approvalId: string;
      };
    }
  | {
      status: "rejected";
      workspaceId?: string;
      threadId: string;
      error: ThreadControlError;
    };
```

Stopping is idempotent only for a thread already in `stopped`. A completed or
failed thread returns non-retryable `conflict`. Internal Full stops directly.
Internal Supervised creates a human approval request.

### `thread_wait`

```ts
type ThreadWaitInput = {
  threadIds: string[];
  until?: "attention_or_terminal" | "terminal";
  timeoutSeconds?: number;
};

type ThreadWaitItem = {
  workspaceId: string;
  threadId: string;
  state: ThreadObservedState;
};

type ThreadWaitResult =
  | {
      status: "success";
      timedOut: boolean;
      results: ThreadWaitItem[];
    }
  | {
      status: "rejected";
      error: ThreadControlError;
    };
```

The omitted boundary is `attention_or_terminal`. It is satisfied by
`waiting_for_approval`, `waiting_for_user`, `completed`, `failed`, or `stopped`.
The `terminal` boundary is satisfied only by `completed`, `failed`, or
`stopped`.

The call succeeds when every target reaches the boundary or the timeout
expires. A timeout returns `status: "success"` with `timedOut: true` and each
thread's authoritative current state. It does not cancel, retry, or mutate
work.

The service rejects the whole wait without partial results when any target is
invalid or unreadable. A source stop or disconnect ends its active waits. It
does not stop the destination threads.

## Authority matrix

| Operation       | Internal provider-session MCP                      | Paired external MCP                                                                            |
| --------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Search Projects | All registered Projects                            | Selected Workspaces with `projects:read`                                                       |
| List worktrees  | Any registered Project                             | Selected Workspace with `worktrees:read`                                                       |
| Create thread   | Any registered Project                             | Selected Workspace with `threads:create`; new worktree also needs `worktrees:create`           |
| Search or read  | Any other thread                                   | Owned thread with `threads:read-owned`, or selected Project thread with `threads:read-project` |
| Send            | Any other thread; Full direct, Supervised approval | Owned thread with `threads:send-owned`, or selected Project thread with `threads:send-project` |
| Stop            | Any other thread; Full direct, Supervised approval | Owned thread with `threads:stop-owned`, or selected Project thread with `threads:stop-project` |
| Wait            | Any other readable thread                          | Any thread the integration may read                                                            |

The source thread is excluded from every internal search and target operation.
A direct target returns the same `not_found` result as an unknown thread.

For external callers, both the selected Workspace and the operation scope must
permit the action. Owned scopes cover only threads created by that integration.
Project scopes extend authority to other threads in the selected Project.

Unknown, unauthorized, unselected, unreadable, and source-thread targets use
the same non-enumerating `not_found` response. The response omits `workspaceId`
unless the caller already has authority to know that Workspace.

## Approval contract

Only the human user may accept or reject approval requests in version one.
Agents may observe `pending_approval` and `waiting_for_approval`, including the
exact `approvalId`, but no model-facing approval mutation exists.

Approval resumes the original persisted operation. The agent must not repeat
the create, send, or stop request to continue it.

## Persistence and provenance

A delegated thread stores:

```ts
type ThreadDelegationLineage = {
  coordinatorThreadId: string;
  creatorTurnId: string;
  creatorToolCallId: string;
  creationKind: "thread_delegation";
};
```

External-created threads also store their creating `integrationId` for owned
scope checks. Thread delegation is separate from conversation-fork lineage and
provider-owned subagent relationships.

Every accepted operation is audited with caller identity, source thread when
present, target Workspace and thread when authorized, operation, timestamp, and
outcome. Audit data excludes secrets and full prompt bodies.

Existing user messages migrate to `{ type: "legacy" }`. New writes cannot
create that variant. Historical provider and model identities never change
when either thread later changes provider.

## Concurrency and replay

One atomic per-thread gate controls turn dispatch. When user and agent sends
race, the first accepted request starts; the other receives retryable
`thread_busy`.

External capacity is reserved atomically in batch input order before thread
persistence. The active set is `starting`, `running`, `waiting_for_approval`,
and `waiting_for_user`. Unreserved items return retryable `limit_exceeded`.
Reserved successful items remain active if another batch item fails.

The public tools have no caller-managed request ID, idempotency key, or retry
counter. The transport may suppress duplicate delivery internally. Two
intentional calls remain two actions. The model decides whether to retry from
the structured result.

## Lifecycle

- A created thread persists before its initial turn starts.
- A delegated thread continues if the coordinator turn completes, stops, or
  disconnects.
- Deleting the coordinator does not delete delegated threads.
- Stopping or disconnecting the coordinator ends its active waits.
- Mcode does not automatically resume a coordinator when a delegated thread
  changes state. The coordinator calls `thread_wait`.
- Busy-thread steering and queued follow-ups are outside version one.

## Delivery map

- [#959](https://github.com/Mzeey-Empire/mcode/issues/959) establishes shared
  schemas, authority, persistence, Project discovery, worktree discovery, and
  the `ThreadControlService` boundary.
- [#960](https://github.com/Mzeey-Empire/mcode/issues/960) implements
  `thread_create_batch` and placement.
- [#961](https://github.com/Mzeey-Empire/mcode/issues/961) implements
  `thread_search`, `thread_get`, and `thread_wait`.
- [#962](https://github.com/Mzeey-Empire/mcode/issues/962) implements
  `thread_send`, `thread_stop`, provenance, approvals, and concurrency.
- [#963](https://github.com/Mzeey-Empire/mcode/issues/963) adds the paired
  external MCP authority surface.
- [#964](https://github.com/Mzeey-Empire/mcode/issues/964) prototypes and ships
  the coordination interface.
- [#965](https://github.com/Mzeey-Empire/mcode/issues/965) proves the complete
  workflow end to end.

## Verification obligations

Contract tests must cover every input, output, bound, default, discriminated
variant, and invalid combination. Service tests must cover internal and
external authority, ownership, source exclusion, non-enumerating errors,
partial batches, atomic capacity, approval resumption, busy sends, provenance,
replay suppression, timeout behavior, and restart persistence.

The final workflow test must search Projects, create a thread in another
Project, read it, send a follow-up, wait for attention or completion, and stop
it. UI verification must prove destination visibility, source navigation,
pending approval treatment, and historical provider provenance.
