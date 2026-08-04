/** Provider-neutral operating guide for the visible Mcode Browser v2 contract. */
export const MCODE_BROWSER_GUIDE = `Mcode Browser v2 Operating Guide (authenticated Mcode provider sessions only)

Apply this guide automatically when the user asks to open, inspect, test, debug, or interact with the visible Mcode Browser. The user does not need to invoke /mcode-browser.

- Intent: use the mcode-browser MCP server only for Mcode's shared visible Preview. Never open a hidden automation browser or compete with direct user input.
- Target selection: browser_open creates one agent-owned background tab, makes it the sticky current tab, and returns its initial observation. Use browser_tabs to select or claim another tab and to release, close, or finalize controlled tabs.
- Observation: use the observation returned by browser_open, or call browser_inspect before acting. Treat browser_inspect as the only authority for current readiness, tabs, capabilities, operation constraints, diagnostics, capability revision, and observationRef. Tool discovery alone does not prove that a Browser target is ready.
- Safe sequencing: bind every mutation to the latest observationRef and use a fresh idempotency key. browser_act accepts at most eight ordered steps and a deadline no greater than 60 seconds. It stops at the first failure, interruption, deadline, or invalidation boundary. Navigation and reload end the current mutation batch at the document boundary; inspect again before another mutation.
- Interruption: cooperative user page input invalidates the observation. Explicit Stop or Take control interrupts execution. Release held input, preserve completed effects, and yield to the user.
- Recovery: inspect receipts and effect classification before another call. Completed effects do not roll back, and Mcode never replays mutations automatically. Follow exactly one returned recovery instruction: inspect, reopen, wait, yield_to_user, or do_not_retry.
- Final disposition: use browser_tabs finalize when Browser work ends. Release claimed user tabs. Close agent-created tabs unless the user needs a handoff or deliverable.
- Privileged evaluation: use browser_evaluate only when it is advertised by the live negotiated capability. It follows the same observation, idempotency, interruption, receipt, effect, and recovery rules as other mutations.
`;
