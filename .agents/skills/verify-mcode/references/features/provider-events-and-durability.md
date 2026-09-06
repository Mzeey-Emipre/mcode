# Provider events and durability

## Sub-features

- Provider-neutral lifecycle events enter the turn pipeline.
- A successful terminal provider event ends the completion path.
- A target-thread error or terminal stopped status fails the completion proof.
- Assistant data becomes durable before the public conversation query returns it.
- Runtime inspection exposes active count and authoritative runtime snapshots without provider payloads.
- Codex protocol notices use bounded canonical events. Reroutes, warnings, configuration, deprecation, workspace-security, recovery, and unknown notices never expose raw protocol payloads.
- Codex automatic approval review renders one reviewing tool call and one durable terminal result for each native review identity.
- Current provider notices use one expandable surface above Composer. Configuration and deprecation notices remain quiet until requested.
- Public conversation page and first-paint tail queries restore the bounded current-session notice collection separately from transcript messages.

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

### Codex notice triggers and desktop proof

Use [Electron live testing](../../../electorn-live-testing/SKILL.md) for the
desktop chat, Composer, and reload. The following table describes code-derived
expectations, not completed live proof. These notices originate in Codex's
app-server protocol; Mcode has no notice-trigger button.

| Native notification | Trigger evidence to capture | Expected desktop surface |
| --- | --- | --- |
| `warning` | Codex reports a warning | A Provider warning above Composer |
| `guardianWarning` | Codex reports a security warning | A Security warning above Composer |
| `windows/worldWritableWarning` | Codex reports writable paths or an incomplete scan | Expand the Security warning for bounded path samples |
| `configWarning` | Codex reports a configuration diagnostic | Review notices, including the supplied path and line range |
| `deprecationNotice` | Codex reports a deprecation diagnostic | Review notices |
| `model/rerouted` | Codex supplies the source model, destination model, and `highRiskCyberActivity` reason | One Composer notice without a duplicate toast |
| `modelProvider/authRecoveryCompleted` | Codex confirms provider authentication recovery | A system notice in chat |

1. Start an owned Codex thread from the desktop Composer. Record the actual
   provider condition and notification method without credentials or raw payloads.
2. Assert the expected notice text and expand its details. Capture the desktop
   screenshot with the notice visible. Routine occurrence counts must not appear.
3. Reload the same conversation. Assert that the durable notice remains without
   duplicates. Inspect the public conversation result from the desktop's runtime.
4. Check Close and Review notices. Close hides the whole current collection
   without resolving it. Repeated delivery stays hidden; a distinct notice can
   appear. Slash and mention pickers take precedence and preserve the draft.
   Escape closes the picker without resolving the notice. Check the 20-notice
   bound and replacement when a new provider session starts, including a new
   session that emits no notices.
5. Remove only owned fixture state and close only the owned desktop process.

Run the controlled fixture setup before an owned Electron proof:

```sh
bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs desktop codex-protocol-notices setup
```

Set the returned path as the owned Electron runtime's Codex CLI path. Start a
fresh direct Codex thread and send one message. One fixture process supports one
turn. It drives the native app-server boundary, then emits duplicate
configuration and reroute deliveries plus one guardian security warning, plain
warning, authentication-recovery notice, and terminal answer. The duplicate
deliveries prove the existing deduplication path. It does not recreate a real
upstream condition. It does not cover deprecation notices or Windows
writable-path scans. Restore the prior CLI path before you run `desktop
codex-protocol-notices cleanup --confirm-cleanup`.
Direct DOM, client-store, or database injection does not prove the
provider-to-desktop path.

### Composer overlay stacking proof

Use the controlled fixture and an owned Electron window. Do not create notice
or picker state through the DOM, client store, or database.

1. Capture a live Provider notice above the Composer. Record the notice's
   computed `z-index` as `30` and its `document.body` portal parent.
2. Type `/` and then an `@` mention query in separate drafts. For each picker,
   capture the visible picker with computed `z-index` `40`, assert that the
   notice is hidden, press Escape, then assert that the notice returns and the
   exact draft remains. The picker and notice do not coexist by design.
3. Open Add to composer while a notice remains visible. Record the Add menu at
   `z-index` `40` and, where their rectangles overlap, use `elementFromPoint`
   to confirm that an Add-menu descendant receives the hit.
4. Open a real application overlay primitive without changing fixture state.
   Record its `z-index` `50` and a hit test or screenshot showing that it
   covers the notice. The check may use a dialog, popover, tooltip, dropdown,
   or toast, but do not call those surfaces "modals."
5. Save screenshots and a receipt with the selectors, computed values, portal
   parent, rectangle overlap, and hit-test result under
   `.dev/verification/composer-layering/`. Restore settings and remove only
   the owned fixture threads before cleanup.

The local Composer surface is `z-10` and its queued-send status is `z-20`.
Portal-backed composer overlays are not constrained by that local stacking
context. The desktop title-bar root uses `z-index` `60`; its descendants share
that root context.

The current controlled Electron receipt is
`.dev/verification/composer-layering/receipt.json`. It records a `BODY` notice
portal at `z-index` `30`; slash and mention pickers at `40`; coexisting Add menu
and notice surfaces at `40` and `30`; and a Command palette dialog at `50` that
covered the notice coordinate. The associated screenshots are `slash.png`,
`mention.png`, `add-menu.png`, and `dialog.png` in the same directory.

### Controlled Electron proof

Observed in the production Electron app, PID 16396 on app port 41112, with the
native Codex CLI fixture. Cold thread selection and reload both showed Security
warning above Composer before a history scroll. Session diagnostics did not
duplicate authentication recovery.

- `conversation.tail` with limit 2 returned configuration, security, warning,
  model-rerouted, and authentication-recovered notices.
- Expanding and cycling notices revealed guardian, warning, reroute, and
  configuration-location details. In this historical observation, Close hid
  the whole surface and Review notices reopened it.
- Real `/` and `@` pickers hid the notice surface. Escape restored it and kept
  the exact draft.

The initial reload helper timed out after six seconds. It is not a passing
reload proof. A later fresh inspection confirmed navigation had completed, then
the cold reload UI proof passed. Evidence:
`.dev/verification/codex-notices/option-b-cold.png`,
`.dev/verification/codex-notices/option-b-receipt.json`.

`option-b-expanded.png` exposed a child-button hover discontinuity. Retain it
as the defect record, not as visual proof. Follow-up proof used production
Electron PID 20560 and native fixture thread
`6c5efdc4-6dec-4179-bd54-93ae50cf53a0`; Security warning appeared in seven
seconds. The final expanded light and dark screenshots are
`option-b-hover-light-expanded.png` and `option-b-hover-dark-expanded.png`.
In both themes, the expanded title had `aria-expanded="true"`, the title and
Close child backgrounds were `rgba(0, 0, 0, 0)`, and the header background was
`oklab(0.955 -0.000868241 -0.00492404 / 0.6)` in light or
`oklab(0.22 -0.000868241 -0.00492404 / 0.6)` in dark. Dark collapsed state
also had a transparent child background, without a separate capture. Theme was
restored to System through the UI. The Codex CLI path was restored empty,
fixture threads were deleted, the socket and Playwright disconnected, PID 20560
stopped, and fixture cleanup removed the wrapper.

Coverage remains limited to the controlled Codex fixture. It did not include
auth-required Sign in metadata, a deprecation notice, or a Windows native
writable-path trigger.

### First-paint history limit

The controlled Electron proof passed the native protocol, adapter, server, and
public persistence path. `conversation.page` returned one user message, one
security notice, one plain warning, one model-rerouted notice, one
authentication-recovered notice, one assistant answer, and one configuration
session notice. The duplicate configuration and reroute deliveries persisted
once each.

Reproduce the desktop failure:

1. Run `bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs desktop codex-protocol-notices setup`.
2. Set the returned path as the Codex CLI path in the owned Electron runtime.
3. Create a fresh direct Codex thread.
4. Send exactly `CODEX_NOTICE_VERIFICATION: show the controlled protocol notices.`.
5. Capture the live thread, then reload or reopen it.

The initial transcript read returns only the last two messages. In this fixture,
those messages are authentication recovery and the assistant answer. An upward
wheel gesture over the transcript loads the earlier user message and notices,
even when the short transcript has no visible scrollbar. This is not lost data.
Do not use that gesture to prove that current warnings survive first paint.
The Composer notice proof must inspect the current session's notices before any
history scroll, then repeat that assertion after a cold reload.
Evidence: `.dev/verification/codex-notices/checks.json`,
`reroute-toast.png`, `live-notices.png`, and `reloaded-notices.png`.

## Gotchas

### Approval review journey

Verify approval review through the public Composer and public conversation APIs.

1. Register a verifier-owned workspace. In both Composer layouts, select a provider without Auto and capture Manual and Full access with Auto absent. Switch to a supported provider and capture all three choices, then switch back and confirm Auto disappears.
2. Select Auto and send one verifier-owned Codex turn. Record the public dispatch receipt and the review tool-call narration when the native app-server emits it.
3. When strict review routing arrives, capture its manual-required notice. Confirm that no waiting state or permission control appears until the provider emits a real permission request.
4. Confirm one settled review result only. Check the public canonical turn includes the resolved `approvalReviewMode` and its stable reason. Repeat with Full access and confirm that no review label or lifecycle appears.
5. Reopen the thread or reconnect the public socket. Read the same canonical turn and confirm the review result does not duplicate.
6. Persist Auto, switch to an unsupported provider before dispatch, and confirm the dispatch resolves to Manual with a provider-unavailable reason. For a managed-required provider, confirm Full access and incompatible review modes are blocked before dispatch.
7. Stop, fail, and time out an Auto turn where the provider exposes each path. Confirm each active review has one terminal result, then replay a stale review event and confirm it cannot add another result to the replacement attempt.
8. Delete only the verifier-owned workspace and thread after recording screenshots and the public receipt.

Run the Composer selection and durable footer check in both the web client and
Electron when both surfaces are available. Record an unavailable surface as a
verification gap rather than using the other surface as its substitute.

An unavailable native review capability, permission request, terminal path, or managed policy is a verification gap. Do not record ordinary turn completion as approval-review proof.

- The approved prototype's Sign in button was simulated. The current notice contract reports authentication recovery, not an active sign-in requirement. Do not claim a real sign-in action from this fixture.
- Migration backfill uses the newest persisted notice session as an upgrade approximation because older databases have no durable notice-session boundary. New session-start events select the authoritative session, including an empty one.
- Known child-thread notices belong to the child. Unlinked native-thread notices appear in Session diagnostics with an Unlinked provider thread label. Include these cases when attribution changes.
- Completion proof does not cover every event kind. Use the focused event tests for pipeline order, finalization, and durability seams.
- The notice regression gates are `codex-notification-validation.test.ts`, `codex-protocol-coverage.test.ts`, server `conversation-page.test.ts`, and web `agent-event-branches.test.ts`. They cover upstream payloads, command and terminal flow, public replay, session replacement, bounded retention, and reroutes with distinct server message IDs. They do not prove live upstream notice triggers or desktop appearance.
- Web `thread-hydrator.test.ts` and `resident-content.test.ts` cover diagnostics-only hydration, stale fetches racing with live notices, background fetches, and provider session replacement with a warm cache.
- Provider discovery does not check account login. Record a live authentication error as a blocked provider, then rerun after login.
- Classify the result as an application failure only when evidence shows that the application caused the error.
- Run each scenario for Codex, Claude, and Cursor before you claim provider-neutral proof.
- A desktop reload needs `$electorn-live-testing`; this harness proves the public server conversation RPC only.
