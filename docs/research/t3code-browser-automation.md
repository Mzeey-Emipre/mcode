# T3Code browser automation and browser views

Research snapshot: T3Code commit [`5ca32661`](https://github.com/pingdotgg/t3code/tree/5ca32661b7dc8d512305c3bb9237d994a41a1af5), inspected on 18 July 2026.

## Summary

T3Code gives agents control of the same Electron browser tab that a person sees. It does not start a separate Playwright browser. A provider calls MCP tools over an authenticated loopback HTTP endpoint. The server routes each request through a WebSocket broker to the renderer that owns the matching environment. The renderer forwards the operation through Electron IPC to a desktop preview manager, which controls the guest `webContents` with Chrome DevTools Protocol and Playwright's injected locator runtime. The result returns along the same path. The visible `<webview>` and the automated target therefore share navigation, cookies, storage, history, and page state. ([broker](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/server/src/mcp/PreviewAutomationBroker.ts#L420-L579), [renderer host](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/web/src/components/preview/PreviewAutomationHosts.tsx#L244-L594), [desktop manager](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/desktop/src/preview/Manager.ts#L2813-L2894), [browser host](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/web/src/browser/HostedBrowserWebview.tsx#L179-L260))

The design has several strong boundaries: short-lived bearer credentials scoped to a provider session, an environment-aware broker, bounded schemas, typed public errors, sandboxed webviews, serialized agent actions, and explicit human-input interruption. It is still an active implementation, not a defect-free reference. Eight browser automation defects remain open in the inspected repository, including resize timeouts, poisoned sessions after snapshot failure, keyboard reliability, invisible tabs, clipboard permissions, and WSL loopback rewriting. ([issues 3712 through 3718](https://github.com/pingdotgg/t3code/issues?q=is%3Aissue%20state%3Aopen%203712%20OR%203713%20OR%203714%20OR%203715%20OR%203716%20OR%203718), [clipboard issue](https://github.com/pingdotgg/t3code/issues/3738), [WSL issue](https://github.com/pingdotgg/t3code/issues/3938))

## Feature history

The public request appeared as [issue 1342](https://github.com/pingdotgg/t3code/issues/1342). The first browser-view commit landed on 3 May 2026, annotations followed on 4 May, and agent control arrived on 12 June. Those changes were merged through [pull request 3053](https://github.com/pingdotgg/t3code/pull/3053) on 14 June. The feature first shipped in [`v0.0.28-nightly.20260614.552`](https://github.com/pingdotgg/t3code/releases/tag/v0.0.28-nightly.20260614.552) and then in stable [`v0.0.28`](https://github.com/pingdotgg/t3code/releases/tag/v0.0.28). ([browser view commit](https://github.com/pingdotgg/t3code/commit/52c77c1ec4c1c2c2c27b917baaec91d050d0a737), [annotations commit](https://github.com/pingdotgg/t3code/commit/17fb0e4a9a068f3ba6c55871dd44ed3c5d70aefe), [agent-control commit](https://github.com/pingdotgg/t3code/commit/29150b57367062e4382de7fb3ff0c952b7c38c4e))

Later pull requests hardened ownership, live owner streams, edge cases, and background automation and recording. ([PR 3172](https://github.com/pingdotgg/t3code/pull/3172), [PR 3548](https://github.com/pingdotgg/t3code/pull/3548), [PR 3561](https://github.com/pingdotgg/t3code/pull/3561), [PR 3565](https://github.com/pingdotgg/t3code/pull/3565))

## System architecture

```text
Provider agent
    |
    | Streamable HTTP MCP, bearer token
    v
Server /mcp endpoint
    |
    | validated tool request
    v
PreviewAutomationBroker
    |
    | environment and provider-session assignment
    v
Long-lived renderer WebSocket stream
    |
    | typed preview IPC call
    v
Electron PreviewManager
    |
    | CDP 1.3 plus injected Playwright locator runtime
    v
Guest webContents inside the visible <webview>
```

The package boundaries are deliberate:

| Package | Responsibility |
| --- | --- |
| `packages/contracts` | Operation, request, response, stream-event, result, and error schemas. ([source](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/packages/contracts/src/previewAutomation.ts#L14-L848)) |
| `packages/client-runtime` | Typed RPC atoms for connecting an automation host, receiving requests, responding, and reporting focus. ([source](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/packages/client-runtime/src/state/preview.ts#L23-L112)) |
| `apps/server` | MCP authentication, provider-session context, tool handlers, host assignment, request correlation, and timeouts. ([MCP server](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/server/src/mcp/McpHttpServer.ts#L26-L215), [broker](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/server/src/mcp/PreviewAutomationBroker.ts#L38-L579)) |
| `apps/web` | Browser-panel state, visible webview host, long-lived automation consumer, target selection, cursor, chrome, and recording coordination. ([host](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/web/src/components/preview/PreviewAutomationHosts.tsx#L244-L594), [view](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/web/src/components/preview/PreviewView.tsx#L558-L647)) |
| `apps/desktop` | Electron session and webview policy, IPC, tab ownership, CDP execution, artifacts, diagnostics, and human-agent arbitration. ([IPC](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/desktop/src/ipc/methods/preview.ts#L182-L335), [manager](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/desktop/src/preview/Manager.ts#L379-L538)) |

### Request path

1. At provider startup, the server issues an MCP credential and injects its endpoint and bearer configuration into the provider. Each thread has one active credential; issuing another revokes the old credential. ([registry](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/server/src/mcp/McpSessionRegistry.ts#L105-L209), [provider service](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/server/src/provider/Layers/ProviderService.ts#L217-L228))
2. The provider calls a preview MCP tool. Middleware resolves the bearer token into an invocation context, and the handler checks the `preview` capability before invoking the broker. ([HTTP middleware](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/server/src/mcp/McpHttpServer.ts#L66-L84), [context](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/server/src/mcp/McpInvocationContext.ts#L10-L40), [handlers](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/server/src/mcp/toolkits/preview/handlers.ts#L16-L85))
3. The broker selects a connected renderer host in the same environment that supports the requested operation. It pins a provider session to one physical desktop, correlates the response by request ID, and updates tab affinity after successful calls. ([source](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/server/src/mcp/PreviewAutomationBroker.ts#L420-L579))
4. The renderer consumer rejects events from stale stream generations, invokes the current handler, and sends either a typed result or a sanitized typed error. ([consumer](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/web/src/components/preview/previewAutomationRequestConsumer.ts#L26-L120), [sanitizer](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/web/src/components/preview/previewAutomationErrors.ts#L171-L235))
5. The renderer selects or opens a tab, waits for its webview registration and readiness, then forwards the operation through the desktop bridge. The desktop manager performs the action against the guest `webContents`. ([host readiness](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/web/src/components/preview/PreviewAutomationHosts.tsx#L64-L117), [operation dispatch](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/web/src/components/preview/PreviewAutomationHosts.tsx#L300-L594), [desktop API](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/desktop/src/preview/Manager.ts#L2813-L2894))

## Automation contract

The current operation union contains `status`, `open`, `navigate`, `resize`, `snapshot`, `click`, `type`, `press`, `scroll`, `evaluate`, `waitFor`, `recordingStart`, and `recordingStop`. Every request can target a tab. Navigation accepts a direct URL or an environment port and can wait for a readiness condition. Click and type use structured locator objects. Evaluation expressions are capped at 64 KiB. Individual timeouts cannot exceed 60 seconds. ([operation schemas](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/packages/contracts/src/previewAutomation.ts#L14-L461))

The MCP toolkit marks the capability as open-world. Actions are destructive by default, while status-like and snapshot tools receive read-only or safe annotations. Snapshot has a special response path that returns structured metadata plus image content. ([tool definitions](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/server/src/mcp/toolkits/preview/tools.ts#L30-L218), [snapshot response](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/server/src/mcp/McpHttpServer.ts#L91-L195))

A snapshot is more than a screenshot. Its result can include URL, title, viewport, visible text, interactive elements, accessibility data, console and network diagnostics, action history, and a screenshot artifact. The desktop manager bounds visible text to 20,000 characters, interactive elements to 200, evaluation results to 64 KiB, diagnostic history to 200 entries, and screenshot width to 1,280 pixels. ([result schema](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/packages/contracts/src/previewAutomation.ts#L464-L605), [desktop limits](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/desktop/src/preview/Manager.ts#L91-L105), [snapshot implementation](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/desktop/src/preview/Manager.ts#L1817-L1960))

The public error union distinguishes unavailable hosts, unsupported operations, missing tabs or webviews, navigation and readiness failures, control interruption, locator failures, timeouts, evaluation failures, recording failures, and internal failures. The broker maps remote errors into that union instead of returning arbitrary renderer exceptions. ([error schemas](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/packages/contracts/src/previewAutomation.ts#L608-L848), [broker classification](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/server/src/mcp/PreviewAutomationBroker.ts#L180-L280))

## Desktop execution model

The desktop app depends on Electron 41.5.0 and `playwright-core` 1.60.0. It extracts Playwright's internal injected runtime from the installed Playwright bundle, validates that the extracted source is large enough, and evaluates it into the guest page as `__t3PlaywrightInjected`. Locator resolution then uses Playwright semantics, while input delivery uses CDP or page execution. This avoids launching a second browser, but it couples T3Code to a private Playwright implementation detail. ([dependencies](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/desktop/package.json#L14-L28), [runtime extraction](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/desktop/src/preview/PlaywrightInjectedRuntime.ts#L12-L212), [locator setup](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/desktop/src/preview/Manager.ts#L970-L1043))

Each controlled tab gets a CDP 1.3 debugger session with Runtime, Accessibility, Network, and Log domains enabled. Automation fails when DevTools or another debugger already owns the guest. Click resolves a locator, checks visibility and enabled state, scrolls it into view, computes coordinates, shows a cursor, and sends CDP mouse input. Type uses page-side editing so it also works when the webview is offscreen. Press temporarily focuses the guest and restores the previous focus. Wait conditions poll every 100 milliseconds until success or timeout. ([CDP setup](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/desktop/src/preview/Manager.ts#L700-L835), [click](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/desktop/src/preview/Manager.ts#L1963-L2095), [type and press](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/desktop/src/preview/Manager.ts#L2097-L2283), [wait](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/desktop/src/preview/Manager.ts#L2377-L2446))

Agent actions are serialized per tab. The manager records a human-input epoch before an action and checks it throughout the action. Genuine user input increments the epoch, interrupts the agent, and marks the human as controller for 750 milliseconds. Synthetic input expected from the agent is matched and excluded from this interruption path. Cleanup still runs after interruption. ([action control](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/desktop/src/preview/Manager.ts#L837-L968), [input arbitration](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/desktop/src/preview/Manager.ts#L1082-L1205))

Recording has two paths. Visible tabs use canvas capture and `MediaRecorder` at 12 frames per second and 4 Mbps. Background automation uses CDP screencast frames with JPEG quality 80 and a maximum 1,600 by 1,200 frame. Only one recording slot is active, and the web layer handles start, stop, duplicate-stop, and startup races. ([visible recording](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/web/src/browser/browserRecording.ts#L85-L455), [CDP recording](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/desktop/src/preview/Manager.ts#L1740-L1815))

## Browser view and lifecycle

The renderer mounts one automation host for every connected environment, but only inside Electron. Each host creates a random client ID, advertises its supported operations, opens a long-lived stream, reports focus changes, and synchronizes requests with the active preview session. ([host root](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/web/src/components/preview/PreviewAutomationHosts.tsx#L244-L340), [client ID](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/web/src/components/preview/previewAutomationClientId.ts#L1-L4))

The browser host renders every live preview tab as an Electron `<webview>`. A reference-counted desktop-tab lease creates and closes the underlying desktop tab. A separate surface lease prevents stale React owners from moving or resizing the active webview. Inactive webviews move far offscreen and disable pointer input instead of using `visibility: hidden`, because hidden webviews stall background CDP activity. ([host enumeration](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/web/src/browser/ElectronBrowserHost.tsx#L15-L92), [tab lease](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/web/src/browser/desktopTabLifetime.ts#L16-L43), [surface store](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/web/src/browser/browserSurfaceStore.ts#L73-L170), [offscreen style](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/web/src/browser/hostedBrowserWebviewStyle.ts#L18-L48))

The visible panel includes back, forward, refresh, URL entry, external open, annotation, screenshot, recording, hard reload, DevTools, device toolbar, zoom, and data-clearing controls. It overlays the agent pointer and shows whether the human or agent currently controls the page. ([chrome](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/web/src/components/preview/PreviewChromeRow.tsx#L105-L291), [more menu](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/web/src/components/preview/PreviewMoreMenu.tsx#L28-L132), [view](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/web/src/components/preview/PreviewView.tsx#L558-L647), [cursor](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/web/src/components/preview/AgentBrowserCursor.tsx#L14-L77))

## Security and trust boundaries

MCP credentials use 32 random bytes. The server stores only a SHA-256 token hash, binds the session to environment, thread, provider session, provider instance, capability, idle expiry, and absolute expiry, and exposes a loopback endpoint. Defaults are 30 minutes idle and eight hours absolute. Authentication failures return `401` with `no-store`. ([registry](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/server/src/mcp/McpSessionRegistry.ts#L55-L173), [HTTP response](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/server/src/mcp/McpHttpServer.ts#L26-L38))

The Electron window allows webview tags, but `will-attach-webview` rejects partitions outside the preview namespace and forces sandboxing, Node integration off, and the configured preview preload. Preview webviews deliberately use `contextIsolation: false` because the injected runtime must share the page world; sandboxing, disabled Node integration, partition validation, and attachment policy are the compensating controls. ([window policy](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/desktop/src/window/DesktopWindow.ts#L265-L291), [webview preferences](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/desktop/src/preview/WebviewPreferences.ts#L1-L42))

Browser data uses deterministic `persist:` partitions scoped with SHA-256. Electron's user agent is scrubbed. Permission requests are allowlisted to clipboard read/write, notifications, and geolocation. Session clearing removes cookies, local storage, IndexedDB, WebSQL, service workers, and cache. Artifact writes resolve their paths and reject destinations outside the allowed artifact root. ([browser session](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/desktop/src/preview/BrowserSession.ts#L12-L179), [artifact containment](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/desktop/src/preview/Manager.ts#L493-L538))

The capability can navigate to arbitrary sites, evaluate page JavaScript, and send destructive input. Its tool metadata correctly treats that as open-world authority. The credential, broker, and webview controls limit who can exercise that authority and where it is routed; they do not make arbitrary evaluation safe for an untrusted agent. ([tools](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/server/src/mcp/toolkits/preview/tools.ts#L30-L218), [evaluation schema](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/packages/contracts/src/previewAutomation.ts#L392-L418))

## Persistence and recovery

Preview session metadata on the server is explicitly in memory and keyed by thread and tab. The renderer owns session lifecycle and listens to preview events. It can reconstruct a missing server session from its local snapshot during the same process lifetime. Right-panel descriptors persist in local storage, while preview state uses keep-alive atoms. Browser cookies and site storage persist separately in Electron's `persist:` partition. This means panel identity and browser data can survive longer than the in-memory server session, but they are not one durable record. ([server manager](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/server/src/preview/Manager.ts#L1-L11), [renderer recovery](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/web/src/usePreviewSession.ts#L27-L115), [panel persistence](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/web/src/rightPanelStore.ts#L431-L533), [browser partition](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/desktop/src/preview/BrowserSession.ts#L79-L143))

The broker removes assignments and rejects pending requests when a host disconnects. It replaces duplicate connections, prunes stale assignments, fails when no compatible host exists, and applies a 15-second default request timeout. Renderer stream generations prevent responses from a previous connection from being accepted by the new connection. ([broker lifecycle](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/server/src/mcp/PreviewAutomationBroker.ts#L62-L132), [broker invocation](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/server/src/mcp/PreviewAutomationBroker.ts#L282-L550), [consumer](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/web/src/components/preview/previewAutomationRequestConsumer.ts#L26-L120))

## Test coverage and known gaps

The repository has focused tests for broker correlation, tab affinity, connection replacement, environment isolation, provider pinning, capability filtering, failover, stale focus, and response ownership. Desktop tests cover registration races, queued navigation, screenshots, artifact containment, background typing and keys, human interruption, and diagnostics. Renderer tests cover stale streams, early requests, current-handler selection, typed errors, and sanitization. Recording tests cover visibility, start and stop races, duplicate stops, and timeout cleanup. Contract and Electron policy tests cover schema bounds, webview preferences, and browser sessions. ([broker tests](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/server/src/mcp/PreviewAutomationBroker.test.ts#L61-L1031), [desktop tests](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/desktop/src/preview/Manager.test.ts#L122-L1106), [consumer tests](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/web/src/components/preview/previewAutomationRequestConsumer.test.ts#L56-L382), [recording tests](https://github.com/pingdotgg/t3code/blob/5ca32661b7dc8d512305c3bb9237d994a41a1af5/apps/web/src/browser/browserRecording.test.ts#L111-L280))

Open defects show where source-level coverage has not yet produced reliable product behavior:

| Issue | Observed gap |
| --- | --- |
| [3712](https://github.com/pingdotgg/t3code/issues/3712) | Resize can time out and leave inconsistent state. |
| [3713](https://github.com/pingdotgg/t3code/issues/3713) | A snapshot failure can poison later automation. |
| [3714](https://github.com/pingdotgg/t3code/issues/3714) | A missing click target can produce a generic error. |
| [3715](https://github.com/pingdotgg/t3code/issues/3715) | Keyboard input is unreliable on some pages. |
| [3716](https://github.com/pingdotgg/t3code/issues/3716) | The schema accepts `returnByValue: false`, but runtime handling expects a serializable value. |
| [3718](https://github.com/pingdotgg/t3code/issues/3718) | `show: true` can load a tab that remains invisible. |
| [3738](https://github.com/pingdotgg/t3code/issues/3738) | Clipboard writes can be denied silently despite the request-permission allowlist. |
| [3938](https://github.com/pingdotgg/t3code/issues/3938) | WSL localhost rewriting can break loopback and HTTPS targets. |

The last two defects have open fixes in [PR 3739](https://github.com/pingdotgg/t3code/pull/3739) and [PR 3939](https://github.com/pingdotgg/t3code/pull/3939). These issues should be treated as acceptance-test inputs for any comparable implementation, not as incidental upstream bugs.

## Transferable lessons

1. Keep the agent and human on one browser surface. Shared state is the central product property, not an implementation detail.
2. Separate the public tool contract, server routing, renderer ownership, and desktop execution layers. Each boundary needs typed requests, typed errors, cancellation, and independent tests.
3. Scope credentials and host assignment to the provider session and environment. Tab affinity alone is insufficient when several windows or agents are active.
4. Make human input preempt agent input. Use explicit epochs or cancellation tokens so interruption works during multi-step actions and cleanup.
5. Bound every artifact, diagnostic buffer, expression, result, locator list, timeout, and recording slot before exposing the tools.
6. Design background tabs as first-class automation targets. Visibility, focus, surface ownership, recording, and CDP attachment all behave differently offscreen.
7. Test lifecycle races, not only successful actions. Connection replacement, webview registration, navigation readiness, recording startup, manual interruption, and stale responses are core behavior.
8. Keep the Playwright-injection dependency behind a narrow adapter and pin its version. T3Code's extraction from a private Playwright bundle is effective but carries upgrade risk.
9. Use the current open defects as a negative specification. A source-compatible clone without those cases covered would reproduce known failures.

This note is a source analysis. It does not claim a live verification of T3Code's desktop behavior.
