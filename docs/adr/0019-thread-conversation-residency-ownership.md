---
status: accepted
---

# Thread conversation residency has one renderer authority

## Context

The renderer previously created conversation residency boundaries in both
`threadStore` and `workspaceStore`. Each could activate or restore the selected
conversation after a thread-list refresh. Reconnect then refreshed the selected
conversation again. The duplicate paths obscured ownership and risked replacing
resident rows during a failed refresh.

Threads need fast A to B to A switching without retaining every transcript in
memory. They also receive live, validated AgentEvents while their persisted
messages and narrative metadata remain server-owned.

## Decision

`ConversationResidency`, registered by `threadStore`, is the renderer's single
authority for conversation activation, forced refresh, inactive retention,
invalidation, pagination cache synchronization, and prefetch routing.

`ThreadHydrator` remains the collaborator that applies freshness rules and
maintains the bounded LRU conversation cache. Reconnect refreshes the thread
list, then performs exactly one forced refresh of the selected eligible
conversation. If that refresh fails, resident rows remain rendered and carry
the error state.

`workspaceStore` owns workspace rows and selected-thread identity. It does not
create a conversation residency or restore a conversation after list loading.
The renderer projects validated AgentEvents into the resident Thread record.
The server owns persisted messages and narrative metadata. Volatile Turn state
continues through `turn.persisted` until the next turn starts, as defined by the
narrative pipeline guide.

## Consequences

- A Thread has one renderer conversation authority and one bounded cache route.
- A to B to A switching restores retained rows before revalidation completes.
- Pagination and hover prefetch share the same cache ownership as active loads.
- Provider and server contracts remain unchanged.
- Maintained tests assert visible selection, reconnect, event ordering, and
  bounded-cache outcomes. Disposable runtime probes belong under `.dev/`.
