---
status: accepted
---

# Server-Owned Streaming Durability and Provider-Native Recovery

The server is the sole durability authority for user-visible unfinished turn output. It durably checkpoints accepted output before the frontend displays it, and terminal finalization verifies and materializes the complete response and narrative. Renderer `localStorage` is not a primary authority because it would create conflicting copies and require recovery reconciliation.

Recovery prioritizes provider-native same-turn retry, reattachment, and persisted-thread resume. Replacement turns and new sessions are explicit fallbacks only when native recovery is unavailable. Mcode never replays prompts or actions automatically.

## Consequences

- Live streaming performance is a release gate because durability occurs before display.
- Recovery follows a durable ladder from provider-native recovery to explicit replacement or new-session recovery.
- Turn outcomes distinguish completed, cancelled, interrupted, and errored states.
- Providers must expose capability-aware recovery behavior; unsupported native recovery cannot be treated as available.
