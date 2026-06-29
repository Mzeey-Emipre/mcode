---
status: accepted
---

# Browser preview rendering host is switchable behind a hidden setting

## Context

The Browser preview originally rendered live pages through Electron
`WebContentsView`. That gives the main process direct ownership of the guest
`webContents`, but the native view paints outside the React DOM stack. React
menus, dialogs, and other overlays cannot reliably sit above it with `z-index`.

The product still needs Chromium preview tooling: navigation, captures, page
context, local file validation, design mode, browser-use CDP, cookies, cache,
zoom, tabs, and memory-saver behavior. Replacing the host surface must not turn
into a second browser engine effort. ADR-0003 still stands: the in-app preview
is Chromium-only.

## Decision

Add a hidden setting, `preview.rendering.engine`, with two values:

- `webContentsView`, the default native host.
- `webview`, a renderer-owned Electron `<webview>` host.

The setting is hidden JSON state, not a Settings UI row. It gives development
and QA a controlled path to prove overlay behavior and feature parity while
keeping the native host available for rollback.

Main-process trust boundaries stay in place. The renderer may mount a
`<webview>`, but main still validates navigation targets, local file paths,
preview partition policy, capture access, browser-use CDP adoption, cookies,
cache, zoom, permission denial, and popup routing.

## Consequences

- Browser chrome remains React-owned. The active host supplies page status,
  title, favicon, history state, and loading/error state into the same UI.
- `webContentsView` keeps overlay suppression because native views paint above
  React. `webview` must not use freeze-frame or suppression for normal menus.
- Browser commands must resolve through an active-guest abstraction instead of
  assuming `s.view.webContents`.
- Preview tab discard policy applies to both hosts. Discard releases the live
  renderer for whichever host owns the tab and keeps title, URL, favicon, and
  recency metadata for re-warm.
- The flag does not weaken ADR-0003. Both hosts are Electron Chromium surfaces,
  not Firefox, WebKit, or Playwright-managed engines.

## Rejected Options

- **Keep only `WebContentsView`.** This preserves the existing native stack, but
  leaves every React overlay dependent on suppression workarounds.
- **Replace the native host immediately.** This reduces code paths sooner, but
  risks regressions across capture, CDP, local files, tabs, and memory saver.
- **Expose a public setting now.** A visible setting would invite normal users
  onto a migration path before the webview host has full parity.
