# 06: Move the Codex child protocol to a collaboration coordinator

**What to build:** A Codex-specific collaboration coordinator that owns child delegation, native identity binding, delivery uncertainty, retry, child projection, and parent continuation. It uses the generic atomic event store rather than extending generic canonical code with Codex branches.

## Decision Sources

- Canonical Agent Boundary Refactor spec: the complete Codex child lifecycle moves together and uses provider-specific mutation plans.
- ADR 0021: agent-created threads are normal persisted Mcode threads with creator lineage and independent lifecycle.
- Accepted refactor plan: parent and child durable records that need one result commit together.

## Prototype Evidence

Not applicable. This slice is constrained by provider protocol behavior, not a UI prototype.

**Blocked by:** 03: Extract the atomic canonical event store; 04: Extract execution-scoped parent lifecycle and restart recovery.

**Status:** complete

- [x] Generic canonical storage contains no Codex child lifecycle decision or native identity policy.
- [x] The coordinator preserves atomic parent and child durable writes where the current protocol requires them.
- [x] Single, sequential, parallel, and nested child scenarios preserve canonical and legacy terminal parity.
- [x] Uncertain delivery and retry remain explicit recoverable states.
- [x] Every new, extracted, or materially changed production function measures cyclomatic complexity of 10 or less.
