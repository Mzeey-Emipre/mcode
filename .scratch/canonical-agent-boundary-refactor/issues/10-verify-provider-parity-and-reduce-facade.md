# 10: Verify provider parity and reduce the temporary facade

**What to build:** All current providers and both active delivery paths pass live and reload terminal-state parity checks. Consumers use named boundaries, leaving the temporary facade as composition only.

## Decision Sources

- Canonical Agent Boundary Refactor spec: legacy removal is out of scope until every implementation has migrated.
- Accepted refactor plan: final verification covers single, sequential, parallel, and nested narrative scenarios.

## Prototype Evidence

Not applicable. This slice is constrained by end-to-end runtime behavior, not a UI prototype.

**Blocked by:** 04: Extract execution-scoped parent lifecycle and restart recovery; 05: Extract canonical reads and reconnect recovery; 06: Move the Codex child protocol to a collaboration coordinator; 07: Migrate Claude to the refactored dual paths; 08: Migrate Cursor to the refactored dual paths; 09: Migrate Copilot to the refactored dual paths.

**Status:** complete

- [x] Cursor and Copilot passed live delivery and reload. Claude's canonical and legacy routing passed offline tests; its subscription live test was excluded by user instruction.
- [x] Canonical tests cover parent, parallel, nested, reconnect, and restart behavior.
- [x] No caller relies on the temporary facade for policy, reads, provider protocol, or raw database mapping.
- [x] The legacy path remains live and supported pending later provider-migration work.
- [x] Every new, extracted, or materially changed production function measures cyclomatic complexity of 10 or less.

**Verification:** Cursor and Copilot passed live delivery and reload. Claude's subscription live check was excluded by user instruction. The complete changed-code gate passed: typecheck, lint, refactor complexity, affected server tests, and agent scripts.
