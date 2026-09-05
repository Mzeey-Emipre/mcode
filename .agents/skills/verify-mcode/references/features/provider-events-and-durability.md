# Provider events and durability

## Sub-features

- Provider-neutral lifecycle events enter the turn pipeline.
- A successful terminal provider event ends the completion path.
- A target-thread error or terminal stopped status fails the completion proof.
- Assistant data becomes durable before the public conversation query returns it.
- Runtime inspection exposes active count and authoritative runtime snapshots without provider payloads.
- Codex protocol notices use bounded canonical events. Reroutes, warnings, configuration, deprecation, workspace-security, recovery, and unknown notices never expose raw protocol payloads.
- Configuration and deprecation notices use a bounded Session diagnostics panel. Public conversation page and first-paint tail queries restore that panel separately from transcript messages.

## How to get to it (user POV)

1. Open the project for this worktree.
2. Start a short thread with a selected provider and model.
3. Wait for the final reply.
4. Reload or reopen the conversation and confirm that the reply remains.

## Driving it with verify-mcode

Run `runtime health`, then run:

```sh
bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs runtime live --provider codex --model <id> --scenario completion --confirm-provider-call
```

The harness requires `turnComplete` or `ended`. It fails immediately when the target thread emits `error`, `errored`, `cancelled`, `interrupted`, or `paused` first. It then reads `conversation.page` and `message.list` until both return a durable assistant message. The receipt omits assistant text and provider-private payloads.

## Gotchas

- A notice journey starts a Codex thread from the Composer, triggers an available notice variant, then reconnects the public client. Capture the trigger, one stable notice, the public conversation state, and the reconnect result. A repeated notice is a failure. Record unavailable Codex notice variants as coverage gaps.
- Completion proof does not cover every event kind. Use the focused event tests for pipeline order, finalization, and durability seams.
- The notice regression gates are `codex-notification-validation.test.ts`, `codex-protocol-coverage.test.ts`, server `conversation-page.test.ts`, and web `agent-event-branches.test.ts`. They cover upstream payloads, command and terminal flow, public replay, session replacement, bounded retention, and reroutes with distinct server message IDs. They do not prove live upstream notice triggers or desktop appearance.
- Web `thread-hydrator.test.ts` and `resident-content.test.ts` cover diagnostics-only hydration, stale fetches racing with live notices, background fetches, and provider session replacement with a warm cache.
- Provider discovery does not check account login. Record a live authentication error as a blocked provider, then rerun after login.
- Classify the result as an application failure only when evidence shows that the application caused the error.
- Run each scenario for Codex, Claude, and Cursor before you claim provider-neutral proof.
- A desktop reload needs `$electorn-live-testing`; this harness proves the public server conversation RPC only.
