# Managed-worktree Setup readiness

## Behavior

- Mcode returns a managed worktree only after Git completes its checkout.
- The first turn enters the automatic Setup gate after the managed worktree exists.
- Automatic Setup runs in the managed worktree, not the source workspace.
- Setup reads every tracked fixture file before it writes the proof marker.
- A cancellation request for a bound Setup waits until Setup stops, then returns a terminal cancelled startup.
- The queued first turn remains queued after cancellation. It does not enter an agent runtime or make a provider call.
- Cleanup removes the generated thread, worktree, workspace, and fixture repository.

## Proof

1. Start the runtime and run `runtime health`.
2. Run `runtime check` for the focused Git failure regression.
3. Run `runtime worktree-setup --confirm-cleanup`.
4. Inspect the redacted receipt. It must report the complete checkout, a terminal cancelled startup, a cancelled Setup step, an interrupted Setup attempt, a stopped fixture process, no agent runtime, no provider call, and successful cleanup.

The verifier holds Setup open after the marker. It records the fixture process ID, then uses `thread.startup.cancel`. The first turn stays queued, so this proof does not call a provider.

## Failure handling

Cleanup runs after success or proof failure. If the verifier is interrupted after it creates state, run `runtime worktree-setup-cleanup --confirm-cleanup`. It verifies that the stored workspace and thread belong to the owned fixture before deletion.
