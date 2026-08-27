# 09: Migrate Copilot to the refactored dual paths

**What to build:** Copilot turns use the new provider-neutral submit, lifecycle, read, and publication boundaries while current canonical and legacy consumers continue to receive equivalent terminal outcomes.

## Decision Sources

- Canonical Agent Boundary Refactor spec: every current provider implementation keeps both active outputs during migration.
- ADR 0022: durable output is accepted before the frontend displays it.

## Prototype Evidence

Not applicable. This slice is constrained by provider conformance tests, not a UI prototype.

**Blocked by:** 03: Extract the atomic canonical event store; 04: Extract execution-scoped parent lifecycle and restart recovery; 05: Extract canonical reads and reconnect recovery.

**Status:** complete

- [x] Copilot evidence produces the expected canonical terminal state and matching legacy projection.
- [x] Copilot reconnect and restart recovery retain the same visible terminal result after reload.
- [x] Copilot provider conformance fixtures cover duplicate and conflicting terminal signals.
- [x] Every new, extracted, or materially changed production function measures cyclomatic complexity of 10 or less.
