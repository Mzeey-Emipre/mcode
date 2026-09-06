---
name: verify-mcode
description: Verify Mcode behavior in the Electron desktop app and through public server APIs. Use for requests to show or test UI changes, provider events, subagents, and managed-worktree workflows.
---

# Verify Mcode

Use this skill for requested live proof and for changes that cross an Electron UI, persistence, provider adapter, or managed-worktree boundary. Select focused checks with [the agent workflow](../../../docs/guides/agent-workflow.md#focused-checks); do not use a verifier area check as a repository-wide gate.

1. Read `references/features/README.md`. Read each affected feature file. Read `multi-surface-journeys.md` when a workflow crosses product surfaces.
2. Select the proof surface below. Run the health command for each area that needs live proof before proof collection.
3. Run the area `check` command. Drive the documented public UI, API, or CLI path. Capture the required visual and non-visual evidence.
4. Run the documented cleanup command after you finish with harness evidence. Report skipped providers, unavailable models, failed proofs, and coverage gaps.
5. Update this feature map and harness only for stale instructions, harness defects, or verifier-contract mismatches. Report application and environment failures separately. Run the affected proof again after each verifier update.

## Select the proof surface

For Mcode UI changes or a request to show how a feature renders, use the
[Electron live-testing skill](../electorn-live-testing/SKILL.md). It controls an
owned desktop process. Mcode's Preview controls embedded web pages, not the
desktop app's chat and Composer. A public server RPC proves server behavior only.

Run `runtime health` first. If the worktree runtime is missing or stale, follow
`docs/agents/runtime.md` to build and start it, then repeat health. Read the
runtime URL from `.dev/ports.json` without printing credentials. Do not ask the
user for a URL that the worktree runtime supplies.

Check desktop automation dependencies before launch. Use an existing Playwright
installation; request approval before installing a missing tool. Record a
missing dependency as an environment blocker, not a failed application test.

Capture the trigger, an Electron UI assertion, and a screenshot. For durable
behavior, reload the same desktop conversation and inspect the persisted result.
Report desktop proof, server proof, and focused tests separately. A missing
feature-specific proof command is a coverage gap, not proof that the desktop
cannot be tested.

## Commands

Run `bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs --help` for the command reference.

Run a selected runtime check with `runtime check --phase runtime`, `provider`,
`contract`, or `ui`. Repeat `--phase` to select several areas. With no phase,
the command runs every area and retains its normal failure behavior.

Run `runtime health` before AgentService, provider-event, turn-runtime, or selected-text-comments proof. The runtime area rejects a missing or stale server bundle or runtime contract before it calls `/health`.

Run `thread-lifecycle health` before the completed-thread workflow. It also checks the desktop bundle, Playwright, and disposable fixture repository.

The public commands use these namespaces:

```sh
bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs runtime <health|check|inspect|live|worktree-setup|worktree-setup-cleanup|diagnostics|cleanup>
bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs thread-lifecycle <health|check|proof|inspect|cleanup>
bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs composer-queue <check|health|proof|navigation-repro|inspect|cleanup>
bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs desktop codex-protocol-notices <check|setup|inspect|cleanup>
bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs desktop selected-text-comments <setup|proof|cleanup>
```

Runtime live proof requires `--confirm-provider-call`. It creates and normally deletes one direct thread. Thread-lifecycle proof and cleanup require `--confirm-cleanup`. The selected-text-comments setup and cleanup require a stopped Electron session.

Codex protocol-notices `setup` writes only an owned `.cmd` wrapper under `.dev/verification`. It does not start Mcode or Electron, change settings, create a thread, or call a provider. Set the returned path as the Codex CLI path only in the owned Electron runtime. Start a fresh direct thread because an existing Codex session retains its process. One fixture process supports one turn and repeats its config and reroute notifications to prove deduplication. Run `cleanup --confirm-cleanup` only after the coordinator restores the prior CLI path.

Composer-queue `check` runs the deterministic verifier checks. Its tests do not belong to `thread-lifecycle check`, which covers the product renderer and store seams. Composer-queue health and proof use `gpt-5.6-luna` when `--codex-model` is omitted. Both commands still require `--cursor-model <id>`. Pass `--codex-model <id>` to override the Codex default. Proof also requires `--confirm-provider-calls --confirm-cleanup`. If Cursor starts disabled, pass `--allow-enable-cursor`. The proof records the original false setting through its owned Electron-local socket before it enables Cursor. It attempts restoration through that same socket on every terminal path. It retains recovery metadata when restoration fails. It never changes the worktree settings store or Codex. Health does not change settings. It can report that the proof needs Electron-local Cursor enablement. The proof runs both provider entries independently, keeps redacted receipts, writes three composer-only screenshots only for successful provider proofs, and removes only its owned direct threads and Electron sessions. Use `composer-queue navigation-repro --confirm-cleanup` for the no-provider Electron navigation check.

Use `runtime live --provider codex --model gpt-5.6-terra --scenario subagent --confirm-provider-call` for the Codex V2 subagent persistence journey. Read `references/features/codex-subagent-view.md` and complete its Electron steps for navigation, color, and reload proof.

Run `runtime worktree-setup --confirm-cleanup` after changes to managed-worktree creation or automatic Setup. It creates an owned Git project, starts a queued New-worktree turn, proves automatic Setup reads the completed checkout, and removes all generated state without making a provider call. If a proof is interrupted, run `runtime worktree-setup-cleanup --confirm-cleanup` before retrying.

## Evidence and cleanup

Runtime evidence is under `.dev/verification/agent-runtime`. Thread-lifecycle evidence is under `.dev/verification/thread-lifecycle`. Selected-text-comments evidence is under `.dev/verification`.

Do not print `.dev/ports.json`. Read only redacted receipts and diagnostics. Cleanup removes only data that its verifier created. It does not stop a runtime, reset a database, or remove the fixture project.
