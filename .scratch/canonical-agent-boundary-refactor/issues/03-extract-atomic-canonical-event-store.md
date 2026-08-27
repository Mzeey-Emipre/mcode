# 03: Extract the atomic canonical event store

**What to build:** A provider-neutral durable event store that validates canonical drafts, reduces state, persists state and envelopes, derives the checkpoint, and returns committed envelopes from one transaction. A publication service delivers both active outputs only after commit.

## Decision Sources

- Canonical Agent Boundary Refactor spec: durable state, events, checkpoint, and compatibility projection preserve one transaction.
- ADR 0022: canonical events are the final conversation authority and recovery data cannot advance beyond durable output.

## Prototype Evidence

Not applicable. This slice is constrained by transaction behavior, not a UI prototype.

**Blocked by:** 02: Add dual-path commit and delivery receipts.

**Status:** complete

- [x] The generic event store contains no provider-specific lifecycle branch or native protocol terminology.
- [x] A failed transaction participant leaves no persisted partial state and publishes neither active output.
- [x] Publication after a durable commit reports published or deferred without changing the commit result.
- [x] Parent and child streams that require one outcome can commit as one ordered atomic mutation.
- [x] Every new, extracted, or materially changed production function measures cyclomatic complexity of 10 or less.
