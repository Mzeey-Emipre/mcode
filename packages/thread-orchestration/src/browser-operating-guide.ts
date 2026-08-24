/** Provider-neutral operating guide for the visible Mcode Browser v2 contract. */
export const MCODE_BROWSER_GUIDE = `Mcode Browser v2 Operating Guide (authenticated Mcode provider sessions only)

Apply this guide when the user asks to open, inspect, test, debug, or interact with the visible Browser. The user does not need to invoke $mcode-browser.

1. Boundary: use only mcode-browser for Mcode's shared Preview. Never initialize or use bundled generic Browser/Chrome/Node-REPL. Do not launch another browser or profile.
2. Browser-only: do not run shell/terminal commands or read local skills/files. Use mcode-browser with minimal narration.
3. Open and select: browser_open creates a sticky, agent-owned background tab. It returns tab metadata and an observationRef, not a semantic page observation. Use browser_tabs to select, claim, release, close, or finalize tabs.
4. Tabs: browser_tabs select and claim require tabId. Finalize requires dispositions. Release and close may omit tabId.
5. Inspect: browser_inspect is authoritative for readiness, tabs, capabilities, constraints, diagnostics, revision, and observationRef. Inspect before the first action unless browser_open returned sufficient snapshot evidence. Tool discovery alone does not prove readiness.
6. Target: use a semanticId from the latest inspection. Next prefer role plus accessibleName. Use CSS or coordinates only when no semantic target exists. Never guess an ambiguous target.
7. Act: browser_act requires the latest observationRef, a fresh idempotencyKey, deadlineMs, and a non-empty steps array. Never send \`steps: []\`. Canonical click: \`{ "observationRef": "<latest>", "idempotencyKey": "<fresh>", "deadlineMs": 30000, "steps": [{ "operation": "click", "target": { "semanticId": "<from-latest-inspect>" } }] }\`. Required fields include wait durationMs, click target, and assert text/target/url. Use at most eight steps and 60 seconds.
8. Verify: stop on failure, interruption, deadline, or invalidation. Verify non-navigation effects with an assert step or a fresh inspection. Navigation and reload end the batch. Inspect again before another mutation.
9. Interruptions: user input invalidates the observation. Stop or Take control interrupts execution. Release held input, keep completed effects, and yield to the user.
10. Recover: inspect the receipt and effect before retrying. An applied receipt proves the action effect, not the intended outcome. Effects do not roll back. Never replay mutations automatically. Follow exactly one recovery instruction: inspect, reopen, wait, yield_to_user, or do_not_retry.
11. Evidence: request includeScreenshot only for visual evidence or when the user asks. Verify every success claim against current page evidence.
12. Finish: call browser_tabs finalize before replying. Release claimed tabs. Close agent tabs by default. For a tab the user wants open or usable, set disposition handoff and verify success.
13. Evaluate: use browser_evaluate only when the live capability advertises it. Apply the same observation, idempotency, interruption, receipt, effect, and recovery rules.
`;
