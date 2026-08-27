# 02: Add dual-path commit and delivery receipts

**What to build:** Provider implementations submit canonical drafts through one typed command and receive a result that distinguishes durable commit, duplicate input, conflict, and deferred delivery. Canonical and legacy outputs remain supported from the same accepted decision.

## Decision Sources

- Canonical Agent Boundary Refactor spec: append input does not independently assert phase or terminal outcome.
- Accepted refactor plan: canonical and legacy paths remain active until every implementation migrates.
- ADR 0022: server durability precedes user-visible output.

## Prototype Evidence

Not applicable. This slice is constrained by runtime contracts, not a UI prototype.

**Blocked by:** 01: Observe terminal state and enforce refactor complexity.

**Status:** complete

- [x] A provider submission returns a typed commit and delivery result instead of discarding outcome and revision information.
- [x] Durable success remains distinct from deferred publication.
- [x] Canonical and legacy projections are both requested from the accepted lifecycle decision.
- [x] Every new, extracted, or materially changed production function measures cyclomatic complexity of 10 or less.
