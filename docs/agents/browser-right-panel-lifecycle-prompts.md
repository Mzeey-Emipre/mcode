# Browser right-panel lifecycle test prompts

Use these prompts in the seeded `fixture-repo` thread in the worktree-local Electron app. Start the app with `bun run dev:desktop` and confirm that you are using the Electron executable inside this worktree, not the installed Mcode application.

## Recommended clean sequence

### Scenario 1: agent starts Browser while the panel is closed

Close the right panel, then send:

> The right panel is closed. Use only the shared Mcode Browser. Call browser_open for https://example.com in one new agent-owned tab, inspect the page title and first heading, then keep the tab open for my observation. Do not close, finalize, or release the tab. If anything fails, report the exact Browser recovery instruction and stop.

Expected result:

- The agent completes while the right panel stays closed.
- Opening the right panel shows the retained Browser page.
- The page remains interactive and does not reload repeatedly.

### Scenario 2: agent starts Browser while Plan is open

Open the right panel and select Plan, then send:

> The right panel is already open on Plan. Use only the shared Mcode Browser. Call browser_open for https://example.net in one new agent-owned tab, inspect the page title and first heading, then keep the tab open. Do not close, finalize, or release it. I am observing whether Mcode switches this already-open panel from Plan to Browser while retaining Plan in the activity rail. If anything fails, report the exact recovery instruction and stop.

Expected result:

- The visible panel switches from Plan to Browser when the agent-owned page starts.
- Plan remains available in the activity rail.
- Example Domain renders instead of a blank surface.
- The agent completes without a stale host or reconnect error.

### Scenario 3: agent reuses the already-visible Browser tab

Leave Browser visible, then send:

> The Browser panel is already open and visibly showing Example Domain. Use only the shared Mcode Browser. Call browser_inspect for the current authorized tab. Then call browser_act with exactly these argument fields: idempotencyKey, observationRef, deadlineMs, and steps. Set steps to [{ operation: "navigate", url: "https://example.org" }]. Do not include tabId, action, type, target, or url at the top level. After the document boundary, inspect again and report the tab id, title, and first heading. Keep the tab open and do not call browser_open, close, finalize, or release.

Expected result:

- The agent reuses the same tab id.
- The tab navigates to `https://example.org`.
- The page remains visible throughout the activity overlay transition.
- No repeated reload, maximum-update-depth error, stale heartbeat, or host disconnect appears.

## Prompt-shape note

A prompt that only asks the agent to reuse an existing tab does not test Browser startup. If no authorized tab exists, it tests inspection recovery instead and may correctly return `reopen` or `wait`. Use an explicit `browser_open` call in Scenarios 1 and 2.

For same-tab navigation, `browser_act` requires a step shaped as `{ operation: "navigate", url: "https://example.org" }`. The `url` is inside the step, not at the tool's top level. The tool call must also include a fresh `observationRef`, a fresh `idempotencyKey`, and `deadlineMs`.

## Prompts used during diagnosis

These are the exact unique prompts sent to the fixture agent during this investigation.

1. `Scenario 1 baseline. Use only the shared Mcode Browser. Open https://example.com in one agent-owned tab, inspect the page title and first heading, then keep the tab open for my observation. Do not close, finalize, or release the tab. If anything fails, report the exact Browser recovery instruction and stop.`

2. `Scenario 3 baseline. The shared Browser panel is already open on Example Domain. Use only the shared Mcode Browser. Inspect the available tabs, reuse the existing agent-owned tab if it is available, navigate that same tab to https://example.org, inspect the page title and first heading, then keep it open. Do not create a second tab. Do not close, finalize, or release anything. Report the tab id you used.`

3. `Scenario 2 baseline. The right panel is already open on Plan. Use only the shared Mcode Browser. Reuse the existing agent-owned tab, navigate it to https://www.iana.org/help/example-domains, inspect the title and first heading, then keep it open. Do not create another tab. Do not close, finalize, or release anything. Report the tab id. I am specifically observing whether Mcode automatically switches the already-open right panel from Plan to Browser when your Browser action begins.`

4. `Scenario 2 corrected baseline. The right panel is already open on Plan. Start a new shared Browser session by calling browser_open for https://example.net in one new agent-owned tab. Inspect the title and first heading, then keep the tab open. Do not close, finalize, or release it. I am observing whether Mcode automatically switches the already-open right panel from Plan to Browser as soon as your new Browser tab starts.`

5. `Scenario 2 post-fix. The right panel is already open on Plan. Start a new shared Browser session by calling browser_open for https://example.edu in one new agent-owned tab. Inspect the title and first heading, then keep it open. Do not close, finalize, or release it. I am observing whether Mcode switches this already-open panel from Plan to Browser while retaining Plan in the activity rail.`

6. `Scenario 3 post-fix. The Browser panel is already open and visibly showing Example Domain. Use only the shared Mcode Browser. Inspect the currently visible authorized tab, use browser_act to navigate that same tab to https://example.org, inspect its title and first heading, then keep it open. Do not call browser_open. Do not create, close, finalize, or release any tab. Report the tab id and any recovery instruction.`

7. `Scenario 1 clean verification. The right panel is closed. Use only the shared Mcode Browser. Call browser_open for https://example.com in one new agent-owned tab, inspect the page title and first heading, then keep the tab open for my observation. Do not close, finalize, or release the tab. If anything fails, report the exact Browser recovery instruction and stop.`

8. `Scenario 2 clean verification. The right panel is already open on Plan. Use only the shared Mcode Browser. Call browser_open for https://example.net in one new agent-owned tab, inspect the page title and first heading, then keep the tab open. Do not close, finalize, or release it. I am observing whether Mcode switches this already-open panel from Plan to Browser while retaining Plan in the activity rail. If anything fails, report the exact recovery instruction and stop.`

9. `Scenario 1 final verification. The right panel is closed. Use only the shared Mcode Browser. Call browser_open for https://example.com in one new agent-owned tab, inspect the page title and first heading, then keep the tab open. Do not close, finalize, or release the tab. If anything fails, report the exact Browser recovery instruction and stop.`

10. `Scenario 2 final verification. The right panel is already open on Plan. Use only the shared Mcode Browser. Call browser_open for https://example.net in one new agent-owned tab, inspect the page title and first heading, then keep the tab open. Do not close, finalize, or release it. I am observing whether Mcode switches this already-open panel from Plan to Browser while retaining Plan in the activity rail. If anything fails, report the exact recovery instruction and stop.`

11. `Scenario 3 final verification. The Browser panel is already open on the agent-owned Example Domain tab. Use only the shared Mcode Browser. Inspect the currently authorized visible tab, use browser_act to navigate that same tab to https://example.org, inspect its title and first heading, then keep it open. Do not call browser_open. Do not create, close, finalize, or release any tab. Report the tab id and any recovery instruction.`

12. `Scenario 2 stable rerun. The right panel is already open on Plan. Use only the shared Mcode Browser. Call browser_open for https://example.net in one new agent-owned tab, inspect the page title and first heading, then keep the tab open. Do not close, finalize, or release it. I am observing whether Mcode switches this already-open panel from Plan to Browser while retaining Plan in the activity rail. If anything fails, report the exact recovery instruction and stop.`

13. `Scenario 3 stable rerun. The Browser panel is already open and visibly showing Example Domain. Use only the shared Mcode Browser. Call browser_inspect for the current authorized tab, then call browser_act with a navigation step on that same tab to https://example.org using the fresh observationRef and a fresh idempotency key. Inspect the resulting page title and first heading, then keep the tab open. Do not call browser_open. Do not create, close, finalize, or release any tab. Report the tab id and any recovery instruction.`

14. `Scenario 3 exact-schema retry. Keep using the same authorized tab. First call browser_inspect. Then call browser_act with exactly these argument fields: idempotencyKey, observationRef, deadlineMs, and steps. Set steps to [{ operation: "navigate", url: "https://example.org" }]. Do not include tabId, action, type, target, or url at the top level. After the document boundary, inspect again and report the tab id, title, and first heading. Keep the tab open and do not call browser_open, close, finalize, or release.`
