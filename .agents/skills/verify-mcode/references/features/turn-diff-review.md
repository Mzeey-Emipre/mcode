# Last turn native diff

## Sub-features

- Codex full patch updates appear in Last turn as Live Agent changes.
- A completed native patch remains the same after reopening and reconnecting.
- External edits to the same file stay out of the native comparison.
- Git fallback identifies possible same-file edits. Existing Git snapshots remain readable.
- Stop, failure, replacement, and invalidation remove Live state without replacing the last settled comparison.

## How to get to it (user POV)

1. Open an owned fixture repository and start a Codex thread through the composer.
2. Ask Codex to change a named line in a tracked text file, then wait before finishing.
3. Open Review and select Last turn. Open the changed file.
4. While Live is visible, edit a different line in the same file outside the agent.
5. Let the turn finish, then reopen the thread and reconnect the client.

## Driving it with Electron Playwright

- Run `runtime health` against the worktree runtime before collecting evidence. Use the stable Electron live-testing interface and public composer controls.
- Use distinct fixed agent and external marker strings. Save the baseline file and exact prompt in the owned proof directory before sending.
- Assert Live, Agent changes, the expected file, and the exact agent addition in the rendered patch. Capture a screenshot.
- Make the external edit only after native Live evidence appears. Assert the external marker is absent from the rendered native patch but present on disk.
- After completion, assert Live disappears and the agent patch remains. Reopen the thread and reconnect. Assert identical patch contents and source after each operation.
- Select the cumulative comparison and confirm it includes both edits. Return to Last turn and confirm only the agent patch appears.
- Start another held turn and stop it. Confirm Live disappears and the prior settled comparison remains.
- Open an existing snapshot-only thread and confirm its Last turn file is readable with the Git fallback label.
- Record public `turnDiff.getComparison` and `turnDiff.getFileDiff` responses as non-visual evidence without credentials. API evidence supplements the rendered assertions.
- Delete only owned threads, workspaces, and fixture directories. Record cleanup failures.

## Gotchas

- Before native live persistence, record the cap decision or follow explicit user authorization for the live proof. Do not infer permission to post an issue comment.
- Missing provider access, a stale runtime, or unavailable desktop control is a coverage gap. Focused tests do not replace the composer and Review proof.
- The focused real Git/RPC test covers same-file isolation, settled service recreation, cumulative edits, and legacy fallback. The startup migration test covers an existing database. Neither proves rendered labels or an actual provider turn.
- An unsupported or over-limit patch is rejected whole. Do not expect a partial native patch.
