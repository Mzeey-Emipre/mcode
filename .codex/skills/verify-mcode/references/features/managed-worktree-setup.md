# Managed-worktree Setup readiness

## Behavior

- Mcode returns a managed worktree only after Git completes its checkout.
- The first turn enters the automatic Setup gate after the managed worktree exists.
- Automatic Setup runs in the managed worktree, not the source workspace.
- Setup reads every tracked fixture file before it writes the proof marker.
- Cleanup removes the generated thread, worktree, workspace, and fixture repository.

## Proof

1. Start the runtime and run `runtime health`.
2. Run `runtime check` for the focused Git failure regression.
3. Run `runtime worktree-setup --confirm-cleanup`.
4. Inspect the redacted receipt. It must report a running automatic Setup, a matching checkout path, all fixture files, a proof marker, and successful cleanup.

The verifier holds Setup open after the marker. The first turn remains queued, so this proof does not call a provider.

## Failure handling

If the verifier is interrupted after it creates state, run `runtime worktree-setup-cleanup --confirm-cleanup`. It verifies the stored workspace and thread belong to the owned fixture before deletion.
