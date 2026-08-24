---
status: accepted
---

# Server-Owned Streaming Durability and Provider-Native Recovery

The server is the sole durability authority for user-visible unfinished turn output. It durably checkpoints accepted output before the frontend displays it, and terminal finalization verifies and materializes the complete response and narrative. Renderer `localStorage` is not a primary authority because it would create conflicting copies and require recovery reconciliation.

Recovery prioritizes provider-native same-turn retry, reattachment, and persisted-thread resume. Replacement turns and new sessions are explicit fallbacks only when native recovery is unavailable. Mcode never replays prompts or actions automatically.

## Unfinished assistant text

The canonical event store remains the final conversation authority. During an ordinary parent turn, a bounded sidecar checkpoint stores assistant text that the frontend may display before terminal finalization. The sidecar is recovery data, not a second canonical message store.

The server commits each accepted text chunk before publishing its covered deltas. It flushes queued text at 16 KiB, after 63 events, after a maximum age of 250 ms, or before a later semantic event. One unfinished response retains at most 256 KiB and 16,384 chunks. Exact duplicate delivery is idempotent. Sequence gaps and conflicting duplicates stop publication.

Final-response classification can arrive after text publication. The sidecar therefore retains unclassified ordinary-parent text through a later non-final message boundary. Explicit non-final text, child-agent text, tool calls, tool results, hooks, and hidden reasoning keep their existing persistence paths. [Issue #1523](https://github.com/Mzeey-Empire/mcode/issues/1523) owns durable recovery for the complete structured narrative.

Terminal finalization writes the canonical assistant projection before it retires the sidecar. After restart, an existing canonical projection takes precedence over stale sidecar text. Otherwise, recovery restores the exact durable sidecar prefix and records the unfinished turn as Interrupted.

The current text checkpoint path stops publication and interrupts the turn when normal checkpoint storage cannot accept more text. [Issue #1524](https://github.com/Mzeey-Empire/mcode/issues/1524) owns the retry, recovery-journal, bounded-memory, and explicit saving-risk ladder. Those later tiers must preserve the rule that the frontend cannot advance beyond acknowledged durable text unless the user explicitly chooses otherwise.

Production-mode SQLite measurements selected the 16 KiB and 250 ms policy. Packaged visual continuity and supported-platform performance remain release gates under [issue #1532](https://github.com/Mzeey-Empire/mcode/issues/1532).

## Consequences

- Live streaming performance is a release gate because durability occurs before display.
- Recovery follows a durable ladder from provider-native recovery to explicit replacement or new-session recovery.
- Turn outcomes distinguish completed, cancelled, interrupted, and errored states.
- Providers must expose capability-aware recovery behavior; unsupported native recovery cannot be treated as available.
- Structured narrative checkpoints must preserve the ordering barrier established by assistant text: pending text commits before a later visible semantic event is published.
