---
status: accepted
---

# Goals are thread state with transcript receipts

Goal mode spans turns and can become active, paused, blocked, usage-limited,
budget-limited, complete, or cleared depending on the provider. Mcode treats
that state as thread-level provider metadata and renders small transcript
receipts such as `Sent as goal`, `Goal achieved in 19s`, or `Goal cleared`
when the provider or Mcode command layer can prove the event. The rejected
alternative was to model a goal as a prominent chat message or dashboard card;
that would overstate transient UI and make Claude's current Stop-hook wrapper
look equivalent to Codex's native thread-goal protocol.

## Consequences

- The transcript can acknowledge goal events, but it is not the source of
  active goal truth.
- Provider adapters must expose the strongest truthful state they have. Codex
  should bridge native `thread/goal/*` state before Mcode shows native Codex
  goal controls.
- Mcode must not show achieved, paused, blocked, usage-limited, or
  budget-limited receipts for a provider that cannot prove those states.
