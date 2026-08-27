# 08: Migrate Cursor to the refactored dual paths

**What to build:** Cursor turns use the new provider-neutral submit, lifecycle, read, and publication boundaries while current canonical and legacy consumers continue to receive equivalent terminal outcomes.

## Decision Sources

- Canonical Agent Boundary Refactor spec: every current provider implementation keeps both active outputs during migration.
- Accepted refactor plan: publication is a separate result from durable commit and reconnect repairs deferred canonical delivery.

## Prototype Evidence

Not applicable. This slice is constrained by provider conformance tests, not a UI prototype.

**Blocked by:** 03: Extract the atomic canonical event store; 04: Extract execution-scoped parent lifecycle and restart recovery; 05: Extract canonical reads and reconnect recovery.

**Status:** complete

- [x] Cursor evidence produces the expected canonical terminal state and matching legacy projection.
- [x] Cursor reconnect, replay, and snapshot recovery retain the same terminal meaning after reload.
- [x] Cursor provider conformance fixtures cover duplicate and conflicting terminal signals.
- [x] Every new, extracted, or materially changed production function measures cyclomatic complexity of 10 or less.
