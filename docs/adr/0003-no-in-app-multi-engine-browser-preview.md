# No in-app multi-engine (Firefox/WebKit) browser preview

Status: accepted

We will **not** build multi-engine browser preview inside Mcode (issue #452, closed
wontfix). The in-app preview stays Chromium-only via Electron. The rendering host
may be `WebContentsView` or Electron `<webview>` (ADR-0016), but both are
Chromium surfaces. Cross-browser verification is served by launching the user's
**real installed browser** ("Open in browser", already on the roadmap via #554),
not by embedding or bundling Firefox/WebKit.

## Why

The motivating goal is cross-browser **verification** ("does my page render the same
in Firefox/WebKit"), not cross-browser embedding. Embedding a non-Chromium engine in
the panel is categorically impossible, and every workaround is dominated by simpler
options:

- **No desktop Gecko embedding exists.** `GeckoView` is Android-only and Mozilla has
  no desktop plans. WebKit is embeddable only as the *system* engine (WKWebView on
  macOS, WebKitGTK on Linux); there is no first-class embeddable WebKit on Windows.
  Electron `WebContentsView`/`<webview>` are Chromium-only.
- **A Playwright-launched headed window can't be docked or positioned.** Playwright
  exposes no cross-engine window-bounds API (`Browser.setWindowBounds` is
  Chromium-only; WebKit ignores it; Firefox moves only the viewport). It would float
  as a separate, unpositionable window.
- **A Playwright headed window adds little.** It drives only Playwright's *pinned,
  non-real* Firefox/WebKit builds, so it benefits only users who lack the real
  browser (i.e. WebKit on Windows/Linux). If the user has Safari/Firefox, the real
  browser is strictly better; if they don't, a static in-panel screenshot covers the
  same case more cheaply.
- **The category leaders hit the same wall.** Polypane, Sizzy, and Responsively all
  render Chromium-only; Polypane (whose author asked Mozilla directly) ships "Portal"
  to open and sync the page in the user's *real* browsers rather than embedding.

The whole preview tooling surface (capture, design-mode inspect, region/element pick,
and the Codex browser-use bridge over `webContents.debugger` CDP) is Chromium/CDP
coupled and does not port to non-Chromium engines regardless. Changing the Electron
host surface does not change this engine decision.

## Considered and rejected

- **`PreviewEngine` abstraction + bundled Playwright engines in managed windows**
  (the original #452 plan): impossible to dock, pinned non-real builds, 100-300MB
  per-engine downloads, a full parallel host-side implementation of every preview
  feature against the Playwright `Page` API. Not worth the benefit.
- **Static in-panel engine screenshots** (headless Playwright render -> image in the
  panel): the cleanest in-app option and the only way to show WebKit on Windows/Linux,
  but still carries the per-engine download (the no-API-keys rule rules out cloud
  screenshot services). Parked as a possible opt-in plugin, not built now.

## The only proper path (out of scope)

True multi-engine support belongs in a **dedicated standalone developer-browser
product** with an owner responsible for keeping each engine on par with Chrome, Edge,
Safari, and Firefox. If that ever exists, Mcode could integrate it as a **plugin** that
launches engine instances, or expose those engines to the **agent** for browser use.
Both are future, separate efforts, not a fix for #452.
