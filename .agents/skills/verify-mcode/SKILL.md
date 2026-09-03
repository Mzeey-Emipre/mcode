---
name: verify-mcode
description: Verify Mcode runtime, desktop, and managed-worktree workflows before merge. Use for AgentService, provider events, selected text comments, thread completion, and cleanup changes.
---

# Verify Mcode

Use this skill before merge when a change affects Mcode's runtime, desktop UI, persistence, provider adapter, or managed-worktree behavior.

1. Read `references/features/README.md`. Read each affected feature file. Read `multi-surface-journeys.md` when a workflow crosses product surfaces.
2. Run the health command for every affected area before proof collection. The harness does not start or stop a runtime.
3. Run the area `check` command. Drive the documented public UI, API, or CLI path. Capture the required visual and non-visual evidence.
4. Run the documented cleanup command after you finish with harness evidence. Report skipped providers, unavailable models, failed proofs, and coverage gaps.
5. Update this feature map and harness when observed behavior differs from them. Run the affected proof again after each verifier update.

## Commands

Run `bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs --help` for the command reference.

Run `runtime health` before AgentService, provider-event, turn-runtime, or selected-text-comments proof. The runtime area rejects a missing or stale server bundle or runtime contract before it calls `/health`.

Run `thread-lifecycle health` before the completed-thread workflow. It also checks the desktop bundle, Playwright, and disposable fixture repository.

The public commands use these namespaces:

```sh
bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs runtime <health|check|inspect|live|worktree-setup|worktree-setup-cleanup|diagnostics|cleanup>
bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs thread-lifecycle <health|check|proof|inspect|cleanup>
bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs composer-queue <check|health|proof|navigation-repro|inspect|cleanup>
bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs desktop selected-text-comments <setup|proof|cleanup>
```

Runtime live proof requires `--confirm-provider-call`. It creates and normally deletes one direct thread. Thread-lifecycle proof and cleanup require `--confirm-cleanup`. The selected-text-comments setup and cleanup require a stopped Electron session.

Composer-queue `check` runs the deterministic verifier checks. Its tests do not belong to `thread-lifecycle check`, which covers the product renderer and store seams. Composer-queue health and proof use `gpt-5.6-luna` when `--codex-model` is omitted. Both commands still require `--cursor-model <id>`. Pass `--codex-model <id>` to override the Codex default. Proof also requires `--confirm-provider-calls --confirm-cleanup`. If Cursor starts disabled, pass `--allow-enable-cursor`. The proof records the original false setting through its owned Electron-local socket before it enables Cursor. It attempts restoration through that same socket on every terminal path. It retains recovery metadata when restoration fails. It never changes the worktree settings store or Codex. Health does not change settings. It can report that the proof needs Electron-local Cursor enablement. The proof runs both provider entries independently, keeps redacted receipts, writes three composer-only screenshots only for successful provider proofs, and removes only its owned direct threads and Electron sessions. Use `composer-queue navigation-repro --confirm-cleanup` for the no-provider Electron navigation check.

Run `runtime worktree-setup --confirm-cleanup` after changes to managed-worktree creation or automatic Setup. It creates an owned Git project, starts a queued New-worktree turn, proves automatic Setup reads the completed checkout, and removes all generated state without making a provider call. If a proof is interrupted, run `runtime worktree-setup-cleanup --confirm-cleanup` before retrying.

## Evidence and cleanup

Runtime evidence is under `.dev/verification/agent-runtime`. Thread-lifecycle evidence is under `.dev/verification/thread-lifecycle`. Selected-text-comments evidence is under `.dev/verification`.

Do not print `.dev/ports.json`. Read only redacted receipts and diagnostics. Cleanup removes only data that its verifier created. It does not stop a runtime, reset a database, or remove the fixture project.
