# Browser v2 rollout

Browser v2 uses one process-wide rollout decision. A provider cannot select a different Browser command surface.

Development, nightly, and stable builds use Browser v2. The legacy MCP tools are deprecated for normal use. Keep the hidden global rollback through one complete stable observation cycle.

## Evidence

Read `browserAutomation.nightlyEvidence` from `GET /health`. The field name remains unchanged during the stable observation cycle. The report contains:

- The rollout mode and reason.
- The unexpected-failure rate.
- A count for each failure class.
- The zero-tolerance outcome counts.
- Bounded, content-free failure bundles.

The Browser lifecycle log uses the same correlation ID from MCP routing through cleanup. It does not contain typed values, credentials, headers, page content, screenshots, evaluation data, full URLs, or response bodies.

## Activate the global rollback

The rollback changes the Browser tools for all providers. Restart the application after each environment change.

1. Set `MCODE_BROWSER_V2_LEGACY_ROLLBACK=1` before you start Mcode.
2. Start Mcode.
3. Request `GET /health` from the worktree server.
4. Confirm that `browserAutomation.nightlyEvidence.rollout.mode` is `legacy`.
5. Confirm that `browserAutomation.nightlyEvidence.rollout.reason` is `legacy-rollback`.
6. Start one session for each supported provider.
7. Confirm that each session lists the legacy Browser tools and does not list `browser_act` or `browser_tabs`.

Do not use `MCODE_ENABLE_LEGACY_BROWSER_USE_PIPE` for this procedure. That switch controls the older Codex-only raw pipe.

## Recover Browser v2

1. Stop Mcode.
2. Remove `MCODE_BROWSER_V2_LEGACY_ROLLBACK` from the environment.
3. Start Mcode.
4. Request `GET /health` from the worktree server.
5. Confirm that `browserAutomation.nightlyEvidence.rollout.mode` is `browser-v2`.
6. Confirm that each supported provider lists `browser_open`, `browser_inspect`, `browser_act`, and `browser_tabs`.

## Host lifecycle invariant

Closing or finalizing an agent-controlled tab removes the target before the Browser response is delivered. The renderer host must keep that request alive until it reconciles the close and sends the final receipt. Target removal still cancels every operation that did not request the removal.
