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

Run `bun .codex/skills/verify-mcode/scripts/verify-mcode.mjs --help` for the command reference.

Run `runtime health` before AgentService, provider-event, turn-runtime, or selected-text-comments proof. The runtime area rejects a missing or stale server bundle or runtime contract before it calls `/health`.

Run `thread-lifecycle health` before the completed-thread workflow. It also checks the desktop bundle, Playwright, and disposable fixture repository.

The public commands use these namespaces:

```sh
bun .codex/skills/verify-mcode/scripts/verify-mcode.mjs runtime <health|check|inspect|live|worktree-setup|worktree-setup-cleanup|diagnostics|cleanup>
bun .codex/skills/verify-mcode/scripts/verify-mcode.mjs thread-lifecycle <health|check|proof|inspect|cleanup>
bun .codex/skills/verify-mcode/scripts/verify-mcode.mjs desktop selected-text-comments <setup|proof|cleanup>
```

Runtime live proof requires `--confirm-provider-call`. It creates and normally deletes one direct thread. Thread-lifecycle proof and cleanup require `--confirm-cleanup`. The selected-text-comments setup and cleanup require a stopped Electron session.

Run `runtime worktree-setup --confirm-cleanup` after changes to managed-worktree creation or automatic Setup. It creates an owned Git project, starts a queued New-worktree turn, proves automatic Setup reads the completed checkout, and removes all generated state without making a provider call. If a proof is interrupted, run `runtime worktree-setup-cleanup --confirm-cleanup` before retrying.

## Evidence and cleanup

Runtime evidence is under `.dev/verification/agent-runtime`. Thread-lifecycle evidence is under `.dev/verification/thread-lifecycle`. Selected-text-comments evidence is under `.dev/verification`.

Do not print `.dev/ports.json`. Read only redacted receipts and diagnostics. Cleanup removes only data that its verifier created. It does not stop a runtime, reset a database, or remove the fixture project.
