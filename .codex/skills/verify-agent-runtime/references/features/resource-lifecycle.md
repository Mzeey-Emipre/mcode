# Resource lifecycle

## Sub-features

- A stopped turn releases its active session, while its cancelled runtime snapshot remains available for reconnect hydration.
- A harness-created direct thread can be deleted without worktree cleanup.
- Direct deletion detaches active handoff descendants before it deletes the completed parent.
- Managed cleanup removes its named branch after a worktree directory disappears.
- One deletion flow owns runtime teardown for each thread.
- Harness cleanup removes only harness-created receipts, timelines, and check logs.
- Diagnostics show bounded file metadata without raw logs or provider payloads.

## How to get to it (user POV)

1. Start and stop a thread in the current project.
2. Delete the thread and keep the project checkout.
3. Confirm that no running indicator remains.
4. Remove verification evidence when you no longer need it.

## Driving it with verify-agent-runtime

Run `health`, then `check`. The cleanup tests use disposable Git repositories and prove retained-parent lineage, missing managed worktrees, named branch removal, and one teardown owner. Run `inspect` before and after a stop scenario. The live command requires `thread.delete` to confirm deletion of its own direct thread unless `--keep-thread` is present. Run `cleanup` to remove harness-created files under `.dev/verification/agent-runtime`.

## Gotchas

- `cleanup` does not stop a runtime and does not reset or delete a database.
- The public RPC API cannot create active handoff lineage without a provider turn. The focused cleanup test is the proof for that state.
- Memory-pressure integration remains a coverage gap.
