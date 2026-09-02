# Browser automation in web development mode

**Status:** Proposed

**Delivery target:** Continue on the PR #883 integration branch

**Related design:** Existing agent browser automation design

## Problem Statement

Mcode's browser automation is currently coupled to the Electron preview host.
Agents can use the visible Browser in the desktop app, but an agent running the
worktree-local web runtime through `agent:up` cannot exercise Mcode's internal
Browser surface. This blocks fast agent-driven testing of browser workflows and
makes web development mode behave differently from the desktop path.

The solution must keep one shared page state for the user and the agent. It must
also preserve the existing Electron control path, broker authority, security
boundaries, tab identity, cancellation behavior, and bounded browser payloads.
The client boundary is shared by both runtimes: `BrowserSessionDriver` is the
single Browser v2 command entry, `BrowserTargetRegistry` owns logical target
lifetime outside React, and web and Electron provide one runtime-adapter
contract. React only projects registry state and attaches or detaches runtime
handles. Broker and MCP ownership remain unchanged.

## Solution

Add a development-only browser automation path for the pure web runtime. The web
runtime will render a same-origin preview in an iframe and expose a bounded DOM
executor to the existing broker and MCP contract. Agents will use the same
high-level operations in both web and Electron modes: snapshot, navigation,
click, type, and screenshot.

The web path is opt-in through an explicit feature flag that defaults off. The
Electron path remains the production-capable implementation and remains the
fallback when the web flag is absent. The server broker remains the authority
for credentials, operation validation, ownership, routing, timeouts, and
cleanup.

The first release supports same-origin pages only. Cross-origin pages and
unsupported operations fail with typed errors. Privileged page evaluation is
disabled in web mode. A later, separately scoped phase may add an external CDP
or extension bridge if product requirements justify that boundary.

## User Stories

1. As an agent running `agent:up`, I want to discover a registered web preview,
   so that I can test the application's Browser workflow without launching the
   desktop shell.
2. As an agent, I want to open a safe same-origin preview page, so that my
   actions operate on the page the developer can see.
3. As an agent, I want a bounded snapshot of the visible DOM, so that I can
   understand page state before acting.
4. As an agent, I want to navigate the preview, so that I can test route changes
   and page transitions.
5. As an agent, I want to click a visible target, so that I can exercise the
   application's interactive controls.
6. As an agent, I want to type into an eligible field, so that I can test form
   behavior using the same page state as a human.
7. As an agent, I want a screenshot of the preview, so that visual state can be
   inspected during a test.
8. As an agent, I want unsupported operations to return a stable typed error,
   so that I can choose a supported recovery action instead of guessing.
9. As an agent, I want cross-origin access to fail closed, so that a web-dev
   adapter cannot bypass browser same-origin protections.
10. As an agent, I want privileged evaluation unavailable in web mode, so that
    development enablement does not create an uncontrolled script boundary.
11. As a developer, I want the web automation flag disabled by default, so that
    ordinary web development does not silently expose an automation target.
12. As a developer, I want one explicit flag to enable web automation, so that
    local agent testing is easy to turn on and easy to turn off.
13. As a developer, I want the existing Electron browser automation path to keep
    working, so that desktop behavior is not regressed by web support.
14. As a developer, I want the server broker to remain the authority, so that
    web mode does not introduce a second credential or routing system.
15. As a developer, I want target identity to include worktree and connection
    context, so that one worktree cannot accidentally control another runtime.
16. As a developer, I want target identity to include workspace and thread, so
    that actions stay within the intended Mcode conversation.
17. As a developer, I want target identity to include tab and generation, so
    that a stale host cannot act on a replaced preview page.
18. As an agent, I want sequential operations to remain sticky to one target,
    so that a snapshot followed by a click cannot land on different tabs.
19. As a developer, I want duplicate registrations handled deterministically,
    so that reconnects do not create ambiguous owners.
20. As a developer, I want a browser host to unregister on disconnect, so that
    the broker does not route work to a dead page.
21. As a developer, I want reloads to replace the target generation, so that
    in-flight work against the old page is rejected or cancelled.
22. As a developer, I want reconnects to rebuild registration state, so that a
    restarted web runtime can resume cleanly without stale ownership.
23. As a developer, I want stale tabs removed after close or replacement, so
    that memory and routing registries remain bounded.
24. As a human user, I want pointer or keyboard input to cancel an active agent
    action, so that I regain control immediately.
25. As a human user, I want cancellation to use an abortable operation, so that
    the page is not left with a partially applied agent action.
26. As a human user, I want the Browser surface to show when web automation is
    disabled or unavailable, so that I understand why an agent cannot act.
27. As a developer, I want web mode to keep page state in the visible iframe,
    so that agent observations match what browser-based QA sees.
28. As a developer, I want iframe cleanup on unmount and tab close, so that
    listeners, timers, and pending operations do not leak across tests.
29. As a developer, I want action payloads and snapshots bounded, so that a
    large page cannot exhaust the web runtime or broker.
30. As a developer, I want sensitive input values excluded from logs and action
    history, so that test automation does not leak credentials.
31. As a provider integrator, I want the same provider-neutral MCP operations in
    web and Electron modes, so that provider behavior does not fork by runtime.
32. As a test author, I want a deterministic fixture page, so that browser
    tests can fail for real interaction regressions.
33. As a test author, I want a live test through `agent:up`, so that the highest
    seam covers broker routing to the visible web target.
34. As a maintainer, I want focused contract, server, and web tests, so that
    failures identify the owning boundary.
35. As a maintainer, I want the monorepo verification floor to remain green, so
    that shared contract changes do not break other packages.
36. As a maintainer, I want the implementation split into independent tickets,
    so that contracts, broker behavior, web execution, and verification can
    progress in parallel.
37. As a maintainer, I want each follow-up ticket to reference PR #883, so that
    every change continues on the same integration baseline.
38. As a maintainer, I want the web behavior stable before structural cleanup,
    so that refactoring does not hide functional regressions.
39. As a maintainer, I want duplicated provider browser-session lifecycle logic
    extracted after stabilization, so that future providers share safer cleanup.
40. As a provider maintainer, I want provider-specific transport and restart
    behavior preserved during extraction, so that the shared service does not
    erase provider differences.

## Implementation Decisions

1. **Runtime scope.** The first implementation targets the worktree-local web
   runtime started by `agent:up`. It does not require an Electron window.
2. **Visible target.** Web mode uses a same-origin iframe and DOM executor. The
   iframe is the visible page state that both the developer and agent inspect.
3. **Feature flag.** Web automation is guarded by one explicit development flag
   with a secure default of disabled. The flag must be evaluated before host
   registration and must not alter the Electron default.
4. **Authority.** The existing server broker and MCP boundary remain responsible
   for capability credentials, request validation, ownership, sticky routing,
   timeouts, cancellation, and shutdown cleanup.
5. **Target identity.** A registered target is identified by worktree identity,
   connection identity, workspace, thread, tab, and generation. Requests with a
   missing or mismatched identity fail closed.
6. **Sticky routing.** A provider session remains assigned to its selected target
   until the target is replaced, disconnected, revoked, or explicitly released.
7. **Operation set.** The web MVP supports status and registration plus bounded
   snapshot, navigation, click, type, and screenshot operations. It reuses the
   provider-neutral operation vocabulary already used by Electron.
8. **DOM boundary.** The executor operates only on the iframe's same-origin DOM
   and uses bounded selectors, text, coordinates, payload sizes, and operation
   timeouts. It does not expose raw browser or renderer handles.
9. **Cross-origin behavior.** Cross-origin navigation or DOM access returns a
   typed unsupported or cross-origin error. The adapter does not weaken browser
   security headers or same-origin policy.
10. **Evaluation policy.** Privileged page evaluation is not available in web
    mode. Adding it requires a new security review and an explicit capability
    decision.
11. **Human takeover.** Pointer and keyboard listeners advance the host control
    epoch and abort active agent actions. Synthetic events generated by the
    executor must not immediately cancel themselves.
12. **Lifecycle.** Registration, iframe mount, reload, tab switch, thread switch,
    disconnect, unmount, and process shutdown all release listeners, pending
    work, and stale generations.
13. **Electron preservation.** The Electron path keeps its current visible
    preview, adoption, CDP, capture, and security behavior. Web mode selects a
    different executor behind the host capability boundary.
14. **Client ownership.** `BrowserSessionDriver` selects the runtime adapter for
    every Browser v2 dispatch. `BrowserTargetRegistry` retains logical records
    across panel hiding, tab changes, thread switches, and ordinary remounts;
    explicit tab, thread, or workspace deletion releases them. React does not
    own target existence.
15. **Contract compatibility.** Shared schemas remain provider-neutral. Any new
    web capability or error is added as a discriminated, bounded contract and
    consumed by every importing package.
16. **UI behavior.** The Browser panel exposes a clear unavailable or disabled
    state in web mode and does not imply arbitrary browsing support.
17. **Code structure phase.** After web behavior reaches a stable release
    candidate, extract duplicated provider credential and browser-session
    lifecycle into a `BrowserAutomationSessionLease` service. The lease owns
    issue, refresh, expiry, revocation, pending cleanup, and shutdown release.
18. **Provider boundaries.** The lease does not own provider-specific transport,
    restart or resume policy, environment overrides, MCP descriptor format, or
    provider event mapping.
19. **Refactor sequence.** Add the lease and tests without callers, migrate one
    provider, verify, then migrate the remaining providers incrementally. Do not
    combine this extraction with the first web executor change.

## Testing Decisions

1. The highest-value seam is a live broker-to-visible-target scenario through
   `agent:up`. It must register the web host, route a real operation, observe the
   result, and prove that the action changed the visible same-origin page.
2. Use a deterministic local fixture page with controls for navigation, text
   input, click state, screenshot state, and an intentional cross-origin case.
3. Contract tests must cover valid web target identity, generation replacement,
   bounded operation payloads, and typed unsupported or cross-origin errors.
4. Server tests must cover capability validation, sticky workspace and thread
   routing, duplicate registration, target loss, timeout, cancellation, and
   cleanup on disconnect and shutdown.
5. Web tests must cover flag gating, host registration, iframe lifecycle,
   snapshot, navigation, click, type, screenshot, human cancellation, reload,
   reconnect, stale-generation rejection, and cleanup.
6. Electron browser automation tests must remain green to prove that selecting
   the web executor does not change the desktop executor.
7. Tests assert observable behavior and failure semantics. They must not assert
   private DOM implementation details or merely restate constants.
8. Sensitive values must be verified absent from logs, action history, error
   messages, screenshots, and broker diagnostics.
9. Run focused package tests for contracts, server, and web first. Then run
   typecheck and lint.
10. Keep live browser evidence, logs, and disposable fixtures under the existing
    development verification area. Do not commit task-specific browser-driving
    scripts.
11. The later session-lease extraction requires provider lifecycle tests for
    issue, refresh, expiry, revoke, pending cleanup, provider stop, and process
    shutdown. Each migrated provider keeps its existing transport tests.

## Out of Scope

- Arbitrary cross-origin DOM control in the web runtime.
- A CDP, extension, or external browser bridge for web mode.
- A second hidden or headless browser process.
- Firefox, WebKit, or any non-Chromium in-app engine.
- Privileged page evaluation in the web executor.
- Replacing or removing the Electron preview host.
- A public Settings toggle for web automation.
- Browser UI redesign unrelated to exposing the development capability state.
- Provider-specific transport rewrites.
- Database migrations for browser target state.
- Extracting provider session lifecycle before the web behavior stabilizes.
- Changing the Electron preview host or Browser v2 contract as part of this MVP.

## Further Notes

All implementation tickets created from this specification must explicitly
reference PR #883 and state that their changes merge into that PR's integration
branch. Ticket boundaries should keep contracts, server broker behavior, web
executor and host registration, UI state, test fixtures, and live verification
independently actionable. Tickets may run in parallel when they touch disjoint
surfaces; integration tickets must depend on the shared contract and broker
decisions they consume.

Recommended delivery order:

1. Lock the web capability and error contract, target identity, and feature-flag
   policy.
2. Implement broker registration, sticky routing, generation checks, and
   cleanup with no Electron changes.
3. Implement the same-origin iframe executor and its focused tests.
4. Connect the Browser host and panel state to the web executor while preserving
   the Electron path.
5. Run the live `agent:up` tracer bullet, focused package tests, and `bun run
   verify`.
6. After behavior stabilizes, deliver the staged
   `BrowserAutomationSessionLease` extraction as separate refactor tickets.

The in-app Browser skill's useful agent ergonomics are preserved through typed
actions, observable snapshots, sticky targets, cancellation, bounded payloads,
and clear errors. Its ability to control arbitrary pages is intentionally not
copied into this same-origin development MVP.
