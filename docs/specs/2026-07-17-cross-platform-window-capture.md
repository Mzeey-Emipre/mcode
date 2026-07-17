# Cross-Platform Window Capture

**Date:** 2026-07-17
**Status:** Research proposal
**Tracking issue:** [#872](https://github.com/Mzeey-Empire/mcode/issues/872)
**Research:** [Codex app feature audit PR #861](https://github.com/Mzeey-Empire/mcode/pull/861)

## Problem

Many bug reports begin outside Mcode: a desktop app dialog, simulator state, design file, spreadsheet, or browser window. Users can take a screenshot, but the image may omit selectable text, app identity, hidden accessible content, scale, and capture time. Automatic foreground capture would be convenient but risks collecting notifications, credentials, private messages, or unrelated windows.

## Product outcome

Add **Capture window** to the composer. The action lets the user select a visible window, captures one reviewed image, optionally extracts bounded accessibility text, and shows the complete payload before attachment. Consecutive captures may append to the same unsent draft, but Mcode never sends or recaptures automatically.

## Goals

- Capture one user-selected window on Windows and macOS.
- Preview the exact screenshot, app identity, metadata, and accessible text before attachment.
- Let users crop, redact, remove accessible text, or cancel.
- Preserve scale, dimensions, capture time, and display identity for debugging.
- Add multiple labeled captures to one unsent message.

## Non-goals

- Continuous screen recording.
- Background surveillance or periodic recapture.
- Capturing administrator prompts, lock screens, protected video, or Mcode itself without explicit selection.
- Automatically treating accessibility text as trusted instructions.

## Capture flow

1. The composer opens a system window picker or a trusted Mcode picker populated from operating-system window metadata.
2. Protected, minimized, unavailable, and disallowed windows explain why they cannot be selected.
3. Mcode captures the selected window once and requests accessibility text only when the user enabled it.
4. A review screen shows the image, owning application, window title, dimensions, scale, display, time, and complete extracted text within its bound.
5. The user may crop the image, draw permanent redactions, remove text, rename the attachment, or cancel.
6. Add to prompt stores the reviewed attachment in the draft. Send remains a separate composer action.

Redactions are rendered into a new image. The unredacted pixels do not remain in the attachment, thumbnail cache, thread record, or provider request. Mcode warns when accessible text contains content outside the visible crop.

## Platform and failure behavior

- Permission is requested only after the user invokes capture.
- A denied permission leaves the composer intact and links to the relevant system setting.
- If a window closes or changes identity before capture, Mcode returns to selection rather than capturing a replacement.
- If accessibility extraction fails, the screenshot can still be reviewed and attached with a visible Text unavailable state.
- Multi-display and fractional-scale captures retain native pixels and report logical dimensions.
- The payload has independent image-byte, pixel, and text-character limits.

## Security and privacy

- Window titles and previews stay local until the user adds the capture to a draft.
- Accessibility text is untrusted external input and is framed separately from user instructions.
- Known password and secure-entry fields are excluded when the platform exposes that state.
- Mcode does not capture itself, notification overlays, clipboard contents, other windows, or off-screen displays as a side effect.
- Temporary unredacted buffers are released after review, cancel, or attachment creation.
- Telemetry records action state and failure class, not pixels, titles, app names, or extracted text.

## Acceptance criteria

1. A user can select one eligible window and review one capture without changing the active draft.
2. The review shows all image, metadata, and accessible text that would be attached.
3. Send is always separate from capture and attachment.
4. Crop and redaction produce a new payload without retaining unredacted pixels.
5. Permission denial, window closure, protected content, text extraction failure, and size overflow have recoverable states.
6. Accessibility text outside the visible image is identified before attachment.
7. Consecutive captures are independently labeled and removable.
8. Captures preserve native pixels across multiple displays and scaling settings.
9. The resulting provider context labels image text and accessibility text as untrusted evidence.
10. Windows and macOS implementations meet the same consent and preview contract.

## Verification protocol

- Unit-test metadata bounds, text truncation, secure-field exclusion, and attachment lifecycle.
- Integration-test permission denial, window identity changes, redaction disposal, and multi-capture drafts.
- Capture a browser, native app, and scaled secondary-display window on each supported operating system.
- Compare the reviewed image with the selected window and inspect the complete provider payload.
- Redact visible text and verify the original pixels are absent from cache, draft storage, and request data.
- Confirm cancel leaves no attachment or durable capture.
- Run `bun run verify` after the live checks.

## Repository anchors

- `apps/electron`
- `packages/contracts`
- `apps/server/src/services/attachment-service.ts`
- `apps/web/src/components/chat`
- `apps/web/src/stores/threadStore.ts`

## Reference behavior

OpenAI documents frontmost-window screenshots plus accessibility text in [Appshots](https://learn.chatgpt.com/docs/appshots). The documented feature is macOS-only. Mcode should validate a cross-platform picker and consent model before committing to implementation.
