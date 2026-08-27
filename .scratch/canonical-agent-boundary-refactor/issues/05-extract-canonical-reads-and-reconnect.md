# 05: Extract canonical reads and reconnect recovery

**What to build:** A read-only canonical service for conversation projection, checkpoint and execution lookup, and reconnect recovery. It supplies a contiguous delta when safe or a snapshot when a replica needs replacement.

## Decision Sources

- Canonical Agent Boundary Refactor spec: reads have no mutation methods and reconnect cannot apply an incomplete live batch.
- ADR 0022: server-owned canonical state is the final conversation authority.

## Prototype Evidence

Not applicable. This slice is constrained by recovery behavior, not a UI prototype.

**Blocked by:** 03: Extract the atomic canonical event store.

**Status:** complete

- [x] Conversation reads, checkpoint lookup, execution lookup, delta selection, and snapshot selection use one read-only boundary.
- [x] A client receives a contiguous canonical delta only when it can apply it safely.
- [x] A gap, incompatible roster change, or stale revision produces a replacement snapshot without changing terminal meaning.
- [x] Existing legacy consumers remain available while canonical reconnect behavior changes internally.
- [x] Every new, extracted, or materially changed production function measures cyclomatic complexity of 10 or less.
