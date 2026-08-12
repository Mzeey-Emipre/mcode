/** Provider-neutral operating guide for the visible Mcode Browser v2 contract. */
export const MCODE_BROWSER_GUIDE = `Mcode Browser v2 Operating Guide (authenticated Mcode provider sessions only)

Apply this guide automatically when the user asks to open, inspect, test, debug, or interact with the visible Browser. The user does not need to invoke $mcode-browser.

- Intent: use only mcode-browser for Mcode's shared Preview. Never initialize or use bundled generic Browser/Chrome/Node-REPL for this target. Do not launch a separate browser/profile or compete with direct user input.
- Browser-only: do not run shell/terminal commands or read local skills/files. Use only mcode-browser and minimum narration/final response.
- Target selection: browser_open creates one agent-owned background tab, makes it sticky, and returns tab metadata plus an observationRef, not a semantic page observation. Call browser_inspect before the first action unless the returned result includes sufficient current snapshot evidence. Use browser_tabs to select or claim another tab and to release, close, or finalize controlled tabs. For elements, prefer semanticId from the latest inspection, then role plus accessibleName, then CSS or coordinates only without a semantic target. Targets must come from the latest inspection; never guess ambiguous matches.
- Observation: browser_inspect is the authority for current readiness, tabs, capabilities, constraints, diagnostics, revision, and observationRef. Tool discovery alone does not prove that a Browser target is ready.
- Safe sequencing: browser_act input must include latest observationRef, fresh idempotencyKey, deadlineMs, expectedControlEpoch from inspection, and a non-empty steps array. Required fields include wait durationMs, click target, and assert text/target/url. Limit batches to eight steps and 60 seconds. Stop on failure, interruption, deadline, or invalidation; verify non-navigation effects with assert or fresh inspect. Navigation/reload end the batch; inspect before the next mutation.
- Interruption: cooperative user input invalidates the observation. Explicit Stop or Take control interrupts execution. Release held input, preserve completed effects, and yield to the user.
- Recovery: inspect receipts and effect classification before another call. An applied receipt proves the action effect, not the intended page outcome. Effects do not roll back and Mcode never replays mutations automatically. Follow exactly one recovery instruction: inspect, reopen, wait, yield_to_user, or do_not_retry.
- Evidence: request includeScreenshot only when visual, layout, focus, or appearance evidence matters or the user asks for visual proof, not after every action. Before answering, verify every user-facing success claim against current page evidence.
- Final disposition: use browser_tabs finalize when Browser work ends. Release claimed user tabs. Close agent-created tabs unless the user needs a handoff or deliverable.
- Privileged evaluation: use browser_evaluate only when the live capability advertises it. Apply the same observation, idempotency, interruption, receipt, effect, and recovery rules as other mutations.
`;
