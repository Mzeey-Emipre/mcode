# Design: Browser View Webview Migration

**Status:** Draft
**Date:** 2026-06-29
**Epic:** N/A

## Overview

Mcode's Browser tab renders live pages through Electron `WebContentsView`. That keeps guest pages isolated and gives the main process direct `webContents` control, but it also puts the page outside the React DOM stack. React overlays cannot reliably appear above it with CSS `z-index`.

The planned target is a renderer-hosted Electron `<webview>` path behind a hidden feature flag. The migration should give the Browser tab normal React overlay behavior while preserving every existing browser feature: navigation, tabs, memory saver, local files, capture, page context, design mode, shortcuts, and browser-use CDP.

## Goals and Non-Goals

### Goals

- Add a feature-flagged `<webview>` rendering path for the Browser tab.
- Prove React overlays appear above `<webview>` before broad refactor work.
- Keep the public `desktopBridge.preview` contract stable during migration.
- Preserve Browser tab behavior with focused tests and live desktop checks.
- Keep main ownership of trust boundaries: URL validation, local file safety, permissions, partition, capture redaction, and CDP.

### Non-Goals

- Removing `WebContentsView` before `<webview>` reaches parity.
- Adding Firefox, WebKit, or any non-Chromium in-app browser engine.
- Making the flag visible in Settings during the migration.
- Redesigning the Browser header, activity rail, right panel, or tab UI.

## Rollout Decision

Use a hidden JSON setting:

- Setting path: `preview.rendering.engine`
- Values: `"webContentsView"`, `"webview"`
- Default: `"webContentsView"`
- The `"webview"` flag uses the renderer-hosted `<webview>` path in every build.
- After webview reaches parity, keep `webContentsView` hidden for one release as rollback, then remove it.
- Settings UI: no row until `<webview>` passes parity and cross-platform overlay proof
- Rollback: set `"webContentsView"` or delete the key
- Environment override: none for v1

This follows the settings guide's max depth: `preview.rendering.engine`.

## Feature Inventory

| Feature | Webview Migration Requirement |
|---------|-------------------------------|
| Browser chrome, omnibox, nav buttons, favicon, title | React remains owner. Page status feeds the same state. |
| Overlay behavior | Native path hides the native view while overlays are open. Webview path uses normal React stacking. Non-modal overlays only intercept pointer events on visible content; modal backdrops may block the page. |
| Empty state and localhost quick-open | Keep behavior. Navigation still enters through main-process validation. |
| Navigation, history, reload, force reload, open external | Route commands to the active guest record. |
| Tabs and page switcher | Host tab identity remains source of truth. Renderer owns warm webview lifetime under the flag. |
| Warm/cold memory saver | Discard releases adoption and destroys or unmounts the warm guest while preserving URL, title, favicon, and recency. |
| Screenshots, region capture, element pick, page context | Capture targets the active guest's `WebContents`. Redaction and spill behavior stay unchanged. |
| Console and failed-request buffers | Buffers key off adopted webview `webContents.id`, not only `s.view.webContents.id`. |
| Capture spill release and cancel capture | Existing bridge methods stay valid for webview guests. |
| Browser-use CDP | Adoption already wins lookup. Finish event wiring and inactive-tab behavior. |
| Local file and `mcode-workspace:` preview | Main keeps validation. Renderer never sets trusted `file:` or `mcode-workspace:` URLs directly. |
| Reserved host shortcuts | Preserve `mod+shift+b`, `mod+shift+d`, `mod+shift+y`, and `mod+1` through `mod+9`; preserve native page chords. |
| Design mode viewport and inspect | Inspect can keep `executeJavaScript`. Viewport sizing moves to renderer CSS. |
| Crash recovery and cooldown | Adopted webview crash surfaces the same error state and cooldown behavior. |
| `window.open`, popups, permissions | Deny popups or route allowed URLs externally. Deny permissions by default. |
| Scrollbar CSS injection | Keep the same fallback scrollbar policy in both hosts while the host switch exists. The fallback uses no `!important` rules, so page-authored scrollbar styles win. Remove native-path injection when `WebContentsView` is removed. |
| Zoom, cookies, cache, guest DevTools | Route to active guest. DevTools remains disabled for webview until a dev-only policy is added. |
| Perf counters and dev HUD | Keep counters meaningful for both engines, adding webview adoption and overlay counters if needed. |

## Target Architecture

### Guest Record

Use a discriminated guest record in the preview session:

```text
Native guest:
  kind: "webContentsView"
  view: WebContentsView
  webContents: WebContents
  owner: main process

Webview guest:
  kind: "webview"
  webContentsId: number
  webContents: WebContents
  owner: renderer element, adopted by main
  adoptionState: pending | attached | released | crashed
  queuedNavigation: validated URL or null
```

Tab state keeps URL, title, favicon, active, warm, recency, and guest kind. `warm` means the tab has a live, non-destroyed guest. Cold tabs keep metadata and reload on re-warm, matching ADR 0002.

### Ownership Split

React owns:

- Creating and sizing flagged `<webview>` elements.
- Mounting or hiding active and warm webviews from the tab model.
- Replacing the webview DOM with the HTML error panel on `error`.
- React overlay z-order for dialogs, dropdowns, command palette, and design controls.
- Renderer-side design viewport sizing.

Electron main owns:

- URL, `file:`, and `mcode-workspace:` validation.
- Preview partition and webview hardening.
- Tab identity, warm/cold decisions, and browser-use CDP registry.
- Page status, load errors, crash state, and cooldowns.
- Capture payloads, redaction, spill files, console buffer, and failed-request buffer.
- Permission denial, popup routing, cookies/cache/zoom, and DevTools policy.

The renderer may request navigation, but main returns a validated URL or error. Renderer-created `<webview>` elements must not receive unvalidated `file:`, `mcode-workspace:`, preload, partition, or webPreferences input from app state.

## Security Boundary

Every attached webview must pass these checks:

- `will-attach-webview` forces `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, no preload, no preload URL, and `partition: "persist:mcode-preview"`.
- Adoption verifies the sender belongs to the same `BrowserWindow`, the target thread/tab exists or is being created by an allowed tab operation, and the `webContentsId` maps to a live guest in the preview partition.
- Main denies permission requests by default.
- Main denies guest `window.open` and routes allowed http or https URLs through `shell.openExternal`.
- Main validates every navigation target before the webview loads it.
- Capture redaction still strips sensitive text, avoids password input contents, and bounds guest-derived strings.
- Logs avoid secrets from URLs, headers, cookies, captured HTML, local paths, and guest errors.

## Migration Slices

### Slice 0: Prove Webview Overlay UX

Build the smallest flagged prototype that mounts and adopts a safe `<webview>` before refactoring the preview stack.

Pass evidence:

- Dialog, Browser overflow menu, command palette, and design controls render above the webview.
- Focus returns correctly between app chrome and guest.
- Host shortcuts still fire while guest is focused.
- High-DPI bounds align with the React surface.
- A canvas or video-heavy page does not punch through overlays.
- Evidence is collected on Windows, macOS, and Linux with screenshots.

Fail condition: if overlays do not reliably paint above `<webview>`, keep `WebContentsView` and stop.

### Slice 1: Flag and Settings Contract

Add `preview.rendering.engine` to full and partial settings schemas, defaults, docs, and settings tests. Keep it hidden from Settings UI.

Acceptance:

- Missing key defaults to `"webContentsView"`.
- Invalid values are rejected.
- Renderer reads the effective value.
- Rollback is documented.

### Slice 2: Guest Runtime Abstraction

Refactor preview handlers away from direct `s.view` access. Add an active-guest resolver plus helpers for listener attach, detach, cleanup, and crash handling.

Acceptance:

- Existing native tests pass with no behavior change.
- Queued navigation works before `did-attach`.
- Listener cleanup prevents stale page-status, console, failed-request, and CDP events.

### Slice 3: Renderer Webview Surface

Promote `PreviewWebview` from adoption helper to active flagged surface. It mounts warm tabs, adopts on `did-attach`, releases on unmount or discard, and never supplies privileged preferences.

Acceptance:

- Loaded page, empty state, error state, thread switch, last-tab close, and panel hide match native behavior.
- Webview guests receive the same thin preview scrollbar fallback after attach and after document navigation, without `!important` rules.
- Page-authored scrollbar styles take precedence over the preview fallback in both hosts.
- Native-path scrollbar injection stays only while `WebContentsView` remains available.
- Native path stays available in the same build.

### Slice 4: Navigation, Status, and Security Parity

Route navigation, reload, history, title, favicon, loading, load-error, crash, popup, permission, shortcut, zoom, cookies, cache, and external-open through the active guest.

Acceptance:

- `PreviewPageStatus` payloads match current reducer semantics.
- Unsafe file traversal and sensitive files are rejected.
- Renderer-provided preload and privileged preferences are rejected.
- Permission requests and popups are denied or externally routed.

### Slice 5: Capture, Context, and Browser-Use Parity

Move screenshot, region capture, element pick, page context, console tail, failed requests, spill release, cancel capture, and browser-use CDP to the active guest resolver.

Acceptance:

- Captures include schema v2 fields, selector hints, redaction, failed requests, console tail, and spill paths.
- Password fields and sensitive content are redacted.
- Browser-use can attach, execute CDP, receive events, and detach without adoption leaks.

### Slice 6: Memory Saver and Lifecycle Parity

Teach discard scheduling to demote webview-backed warm tabs. Release adoption, destroy or unmount the renderer guest, keep metadata, and reload on re-warm.

Acceptance:

- Active visible tab is protected.
- Hidden trim keeps `preview.memorySaver.maxWarm`.
- Cold tabs reload on activation.
- Crash recovery and cooldown match native behavior.
- Adoption records are cleared on tab close, discard, panel close, and window close.

### Slice 7: Remove Freeze-Frame Fallback

After slice 0 and parity tests pass, rely on normal React stacking for webview. Keep native overlay suppression as a hide-only fallback.

Acceptance:

- Webview path uses normal React overlay stacking.
- Non-modal overlay positioners are pointer-transparent and do not render an inert outside backdrop, so uncovered webview pixels still receive hover and pointer events.
- Modal overlays may block the page while open.
- Native path detaches while overlays are open and does not render a snapshot.
- Dialog and dropdown tests assert that no freeze-frame element is rendered.

## Verification Gates

### Live Desktop

Run `bun run dev:desktop` and capture evidence for both engines:

- Load `http://localhost:<port>` and a safe local HTML file.
- Show dialog, overflow menu, command palette, and design controls over a loaded page.
- Exercise navigation, reload, external open, zoom, cookies, cache, tabs, discard, thread switch, and threadless Browser.
- Exercise screenshot, region, element, context, cancel capture, and spill release.
- Verify guest-focus shortcuts, denied popup, denied permission, blocked unsafe file traversal, password redaction, failed-request capture, crash recovery, and adoption cleanup.

### Commands

- `cd apps/desktop && bunx vitest run src/main/__tests__/preview-browser.test.ts src/main/__tests__/preview-webview-adopt.test.ts src/main/__tests__/browser-use-router.test.ts`
- `cd apps/web && bunx vitest run src/components/panels/hooks/__tests__/usePreviewBridge.test.ts src/components/panels/hooks/__tests__/usePreviewCapture.test.ts src/stores/__tests__/previewTabsStore.test.ts src/stores/__tests__/previewSuppressionStore.test.ts`
- `cd packages/contracts && bun run test -- src/models/__tests__/settings.test.ts src/models/__tests__/browser-preview-clamp.test.ts`
- `cd apps/web && bunx playwright test e2e/preview-chrome.spec.ts e2e/right-panel-browser-pages.spec.ts e2e/right-panel-preview-threadless.spec.ts`
- Add and run a flagged webview desktop e2e spec that saves overlay-order screenshots.
- Regression floor: `bun run verify`, `bun run verify:e2e`, and `cd apps/desktop && bun run e2e`.

## Alternatives Considered

### Alternative: Keep WebContentsView and Suppression Forever

This is the rollback path, but it keeps the z-order workaround and per-overlay suppression burden.

### Alternative: Replace Native Browser Immediately

This reduces duplicate paths sooner, but risks regressions across capture, CDP, local files, tabs, and memory saver.

### Alternative: Public Settings Toggle From Day One

A visible Settings row would invite normal users onto an incomplete engine.

## Documentation Updates

- Update ADR 0003 to say the browser stays on Electron Chromium, with `WebContentsView` and `<webview>` as host surfaces.
- Add a new ADR for the rendering engine flag after slice 0 proof passes.
- Update settings docs when the flag lands.
- Update the UI components guide with overlay rules for both paths.

## Open Questions

- Should inactive warm webview tabs stay mounted, or unmount before discard?
- Should guest DevTools work for webview guests in dev builds?

## References

- Electron docs for `WebContentsView`, `View`, BrowserView migration, and `<webview>`.
- Repo anchors: ADR 0002, ADR 0003, `preview-lifecycle.ts`, `usePreviewBridge.ts`, and `preview-webview-adopt.ts`.
