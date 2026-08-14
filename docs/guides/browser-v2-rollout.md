# Browser v2 operations

Browser v2 is the only Browser automation path. Every provider receives the
same scoped MCP gateway and the same current tool contract:

- `browser_open`
- `browser_inspect`
- `browser_act`
- `browser_tabs`
- `browser_evaluate` for privileged sessions only

Read `browserAutomation.nightlyEvidence` from `GET /health` for content-free
diagnostics. The report includes request counts, failure rates and classes,
zero-tolerance outcome counts, retained lifecycle events, and bounded recent
failure bundles. It does not include page content, credentials, headers,
screenshots, evaluation data, full URLs, or response bodies.

The Browser lifecycle log keeps one correlation ID from MCP routing through
cleanup. Browser v2 actions use the latest observation reference, a fresh
idempotency key, and typed recovery results. Navigation, reload, and back end
the current observation boundary. Inspect before another mutation.

## Host lifecycle invariant

Closing or finalizing an agent-controlled tab removes the target before the
Browser response is delivered. The renderer host keeps that request alive
until it reconciles the close and sends the final receipt. Target removal
cancels every operation that did not request the removal.
