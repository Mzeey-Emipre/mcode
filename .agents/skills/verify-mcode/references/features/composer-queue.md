# Composer queue

## Sub-features

- An authoritative, non-guardrail `turnComplete` sends exactly one queued message, then leaves later messages in FIFO order. Persistence alone leaves the queue paused until Continue.
- Stop starts a pending-stop barrier and suppresses automatic drain until every concurrent Stop RPC settles. Late completion, persistence, or guardrail events cannot bypass that barrier.
- Continue sends one queued message only after Stop settles and the thread is idle.
- Dispatch claims one item into an in-flight lease before transport starts. The lease counts toward the 20-message limit and prevents a second dispatch of that item.
- An accepted lease transfers capture spill ownership to the turn. A failed lease restores its item at its original FIFO position and pauses automatic drain. Clear all and deletion invalidate the lease generation, so a later failure releases its spills without recreating a removed queue.

## How to get to it (user POV)

1. Start a thread from the composer.
2. While it runs, queue two follow-up messages.
3. Let the turn complete, then confirm that the first follow-up starts and the second stays queued.
4. Stop a running follow-up and confirm that all remaining messages stay queued, even after its terminal events arrive.
5. Select Continue and confirm that it starts only the next queued message.

## Driving it with verify-mcode

Run the live Codex and Cursor matrix with the default Codex model, `gpt-5.6-luna`, and an exact Cursor model ID. Pass `--codex-model <id>` only to override the Codex default. The proof requires both confirmations because it creates one owned direct thread per provider and sends real provider turns.

```sh
bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs composer-queue health --cursor-model <cursor-model-id> --allow-enable-cursor
bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs composer-queue proof --cursor-model <cursor-model-id> --allow-enable-cursor --confirm-provider-calls --confirm-cleanup
```

If Cursor starts disabled, `--allow-enable-cursor` gives explicit consent for a temporary change through the owned Electron-local `settings.update` socket. Before that change, the verifier writes the Electron runtime directory, Cursor's original disabled state, and its restoration intent to recovery metadata. It attempts to restore that state through the same socket after success, provider failure, matrix failure, interruption cleanup, and cleanup failure. If restoration fails, it retains the recovery metadata. It never changes the worktree settings store or Codex. If Cursor still lacks a CLI login or model after enablement, the verifier restores its Electron-local state and records that provider as blocked.

Health does not change a settings store. When the worktree Cursor state is disabled and the flag is present, health reports that the proof requires Electron-local enablement. The owned proof session makes that reversible change and then checks its provider, CLI, and model state.

For each provider, the Electron proof selects and rechecks the provider and model in the production UI. Each root prompt runs `powershell -NoProfile -Command "Start-Sleep -Milliseconds 5000"`. Each queued prompt waits 10000 milliseconds. The prompts do not read or change repository files. The proof queues A and B while the root turn runs, verifies that completion starts A with B visible, then queues C, stops A, verifies that B and C remain paused, and uses Continue to start B with C visible. Screenshots clip to the composer and queue.

The receipt records safe predicate counts and booleans. Live admission requires exact durable root, A, B, and C prompt identities, exact visible queue rows, and a visible Stop control. It does not require provider start events. Duplicate durable A or B prompts, incorrect queue rows, or an idle composer fail the proof. The receipt retains provider event counts as diagnostics. The deterministic verifier tests retain Codex and Cursor terminal-order checks as supporting adapter coverage.

The proof opens its Electron-local socket before it reads Cursor settings or checks provider readiness. It uses that socket for the temporary Cursor setting, provider and model checks, queue RPCs, and event replay. Once the UI returns the new thread ID, it replays that thread from cursor zero on the same socket. `turnComplete` is a completed terminal. `ended` is completed only when its outcome is `completed` or `success`. The receipt omits event payloads and execution IDs. When the verifier temporarily enables Cursor, the receipt records only that the original state was disabled and that it restored it before owned resource cleanup.

Run the verifier's own deterministic check before proof collection:

```sh
bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs composer-queue check
```

`composer-queue.test.mjs` does not belong to `thread-lifecycle check`. The Composer queue check covers verifier ownership, evidence, selection, and terminal-event behavior. `thread-lifecycle check` remains supporting product evidence for FIFO order, Stop suppression across late terminal events, Continue, in-flight leases, guardrail ordering, capacity, and capture-spill cleanup. Its transport mock stays at the external server boundary.

## Evidence and cleanup

The matrix writes separate redacted receipts under `.dev/verification/composer-queue/receipts/`. A successful provider proof writes three composer-only screenshots. A blocked provider writes its receipt only. Receipts record only bounded counts and booleans for durable prompts, queue rows, running state, terminal evidence, and temporary Cursor restoration. It retains evidence after removing its owned direct thread and Electron process. Interrupted cleanup reconnects only to the recorded Electron-local runtime for that owned session. It restores a pending Cursor setting before it removes recovery metadata. If a proof is interrupted, inspect it, then run:

```sh
bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs composer-queue inspect
bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs composer-queue cleanup --confirm-cleanup
```

Use the no-provider navigation check when Electron fails before a provider turn. It launches and cleans up only an owned Electron session, then records page and context close diagnostics without retaining app content.

```sh
bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs composer-queue navigation-repro --confirm-cleanup
```

## Coverage gap

If `workspace.create` succeeds but its response is lost before the verifier receives a workspace ID, the active record marks workspace ownership as uncertain. Cleanup retains that record and refuses heuristic deletion. Inspect it and resolve the workspace manually before retrying.

Queue editing has a separate capture-spill ownership gap when an edit is abandoned or teardown races it. It is outside queued send and Stop dispatch behavior.
