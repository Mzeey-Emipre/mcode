---
status: accepted
---

# Thread control uses shared enforcement with separate internal and external authority

## Context

Mcode needs to let a running Thread create and coordinate other normal Mcode
Threads, including Threads in another registered Project. Provider-owned
subagent sessions cannot represent this feature because they do not own Mcode
Workspace placement, Worktrees, permissions, persistence, or cross-provider
identity.

The same domain operations will later be available to paired external
integrations. Internal and external callers do not have the same trust
boundary. Duplicating orchestration in two MCP implementations would allow
their lifecycle and authorization rules to drift.

## Decision

Mcode will expose thread control through one provider-neutral `ThreadControlService`. Internal provider-session MCP tools act for the current user across registered Projects and exclude the source thread. Paired external MCP integrations use selected Workspaces, ownership-aware operation scopes, execution limits, and non-enumerating errors. Both adapters construct server-owned authority and the shared service enforces it, which avoids duplicating orchestration while preserving the stricter external trust boundary.

Agent-created conversations are normal persisted Mcode threads with creator lineage, not provider-owned subagent sessions or conversation forks. They remain visible in their destination Project and continue independently when the source turn completes, stops, or disconnects. Deleting the source thread does not delete created threads. Active waits end when the source turn stops or disconnects, and the source explicitly calls the wait tool rather than receiving an automatic resume.

Build is the default interaction mode and Plan is explicit. A running destination rejects another send with `thread_busy`; Mcode does not steer or queue it in the first release. Simultaneous user and agent sends use an atomic per-thread gate: the first accepted send starts and the other receives `thread_busy`.

Full internal authority performs permitted cross-thread mutations directly. Supervised mutations and protected repository operations create correlated approval requests. Only the human user may accept or reject approvals in the first release. Agents may observe pending approval state but cannot approve their own or another agent's requests.

The public contract has no model-managed request ID, idempotency key, or retry
counter. The transport may suppress duplicate delivery internally, while
intentional repeated calls remain distinct. Batch creation preserves partial
success and returns one discriminated result per input item.

Message origin is `composer`, `thread`, or migration-only `legacy`, not `human`
or `agent`. A Thread origin persists the authenticated source Thread, Turn, and
Provider. Assistant messages persist the Provider and model that produced them.
Historical provenance does not change when a Thread later switches Provider.

The normative wire shapes, bounds, error variants, defaults, authority matrix,
and lifecycle behavior are defined in
[the Agent Thread Control Contract](../specs/2026-07-25-agent-thread-control-contract.md).

## Consequences

- Internal agents need no per-Project or per-thread allowlists.
- External integrations need explicit Project selection, scopes, ownership rules, and capacity limits.
- Cross-thread messages must persist source thread, source turn, and source provider provenance.
- Provider adapters remain thin and cannot bypass `ThreadControlService`.
- Project and Thread searches are bounded. Cross-Project Thread results always
  identify their `workspaceId`.
- Unknown and unauthorized targets share a non-enumerating `not_found`
  response.
- Pending approvals are durable operation states, not errors or new requests.
- Busy-thread steering, automatic source resumption, and agent-resolved approvals require a later decision before they can be added.
