# 04: Extract execution-scoped parent lifecycle and restart recovery

**What to build:** A parent-turn lifecycle that starts, finishes, continues, and recovers one execution using an explicit lifecycle decision. It publishes matching canonical and legacy terminal outcomes while preserving safe restart recovery.

## Decision Sources

- Canonical Agent Boundary Refactor spec: execution identity owns terminal guards and lifecycle transitions.
- ADR 0022: recovery restores durable output and records only unfinished turns as interrupted.
- Accepted refactor plan: a provider transport closure is evidence, not an automatic semantic outcome.

## Prototype Evidence

Not applicable. This slice is constrained by runtime lifecycle behavior, not a UI prototype.

**Blocked by:** 01: Observe terminal state and enforce refactor complexity; 02: Add dual-path commit and delivery receipts; 03: Extract the atomic canonical event store.

**Status:** complete

- [x] Allowed lifecycle transitions, idempotent duplicates, and conflicting terminal signals have explicit, tested results.
- [x] A late signal from an old execution cannot change a newer execution in the same thread.
- [x] Restart recovery preserves a previously accepted terminal result and interrupts only an unfinished execution.
- [x] Canonical and legacy consumers receive equivalent terminal outcomes for parent turns.
- [x] Every new, extracted, or materially changed production function measures cyclomatic complexity of 10 or less.
