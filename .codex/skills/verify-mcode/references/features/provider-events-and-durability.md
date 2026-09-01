# Provider events and durability

## Sub-features

- Provider-neutral lifecycle events enter the turn pipeline.
- A successful terminal provider event ends the completion path.
- A target-thread error or terminal stopped status fails the completion proof.
- Assistant data becomes durable before the public conversation query returns it.
- Runtime inspection exposes active count and authoritative runtime snapshots without provider payloads.

## How to get to it (user POV)

1. Open the project for this worktree.
2. Start a short thread with a selected provider and model.
3. Wait for the final reply.
4. Reload or reopen the conversation and confirm that the reply remains.

## Driving it with verify-mcode

Run `runtime health`, then run:

```sh
bun .codex/skills/verify-mcode/scripts/verify-mcode.mjs runtime live --provider codex --model <id> --scenario completion --confirm-provider-call
```

The harness requires `turnComplete` or `ended`. It fails immediately when the target thread emits `error`, `errored`, `cancelled`, `interrupted`, or `paused` first. It then reads `conversation.page` and `message.list` until both return a durable assistant message. The receipt omits assistant text and provider-private payloads.

## Gotchas

- Completion proof does not cover every event kind. Use the focused event tests for pipeline order, finalization, and durability seams.
- Provider discovery does not check account login. Record a live authentication error as a blocked provider, then rerun after login.
- Classify the result as an application failure only when evidence shows that the application caused the error.
- Run each scenario for Codex, Claude, and Cursor before you claim provider-neutral proof.
- A desktop reload needs `$electorn-live-testing`; this harness proves the public server conversation RPC only.
