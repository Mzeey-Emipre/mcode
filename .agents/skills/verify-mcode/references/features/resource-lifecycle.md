# Resource lifecycle

## Sub-features

- A stopped turn releases its active session, while its cancelled runtime snapshot remains available for reconnect hydration.
- A harness-created direct thread can be deleted without worktree cleanup.
- Harness cleanup removes only harness-created receipts, timelines, and check logs.
- Diagnostics show bounded file metadata without raw logs or provider payloads.

## How to get to it (user POV)

1. Start and stop a thread in the current project.
2. Delete the thread and keep the project checkout.
3. Confirm that no running indicator remains.
4. Remove verification evidence when you no longer need it.

## Driving it with verify-mcode

Run `runtime inspect` before and after the stop scenario. The live command requires `thread.delete` to confirm deletion of its own direct thread unless `--keep-thread` is present. Run `runtime cleanup` to remove harness-created files under `.dev/verification/agent-runtime`.

## Gotchas

- `cleanup` does not stop a runtime and does not reset or delete a database.
- The current focused suite lacks direct teardown proof for active, pooled, inactive, and missing-provider sessions.
- Memory-pressure integration remains a coverage gap.
