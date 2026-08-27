# 01: Observe terminal state and enforce refactor complexity

**What to build:** A deterministic status replay that shows how one provider signal becomes canonical state, checkpoint state, legacy projection, and a rendered terminal result. It establishes a repeatable failure for any disagreement and enforces a cyclomatic-complexity limit for this refactor.

## Decision Sources

- Canonical Agent Boundary Refactor spec: diagnose the reported normal-turn failure before naming its cause.
- Accepted refactor plan: canonical and legacy outputs remain active and must have equivalent terminal outcomes.
- User decision: every new, extracted, or materially changed production function in this refactor has cyclomatic complexity of 10 or less.

## Prototype Evidence

Not applicable. This slice is constrained by executable behavior, not a UI prototype.

**Blocked by:** None (can start immediately).

**Status:** complete

- [x] A replay fixture records one execution's provider evidence, normalized decision, canonical envelopes, checkpoint, legacy projection, and renderer result.
- [x] The fixture fails when any terminal result differs and keeps the existing overflow mismatch visible.
- [x] The refactor has a static complexity check that rejects a new, extracted, or materially changed production function over 10.
- [x] The fixture covers live delivery and reload for both active paths.
