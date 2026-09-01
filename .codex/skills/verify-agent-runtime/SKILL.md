---
name: verify-agent-runtime
description: Verify AgentService and thread-runtime behavior before merge. Use for provider-event ingress, turn lifecycle, stop, retry, teardown, durability, and pre-merge runtime changes.
---

# Verify Agent Runtime

Use this skill before you merge changes to `AgentService`, `TurnRuntimeController`, provider-event application, or their lifecycle seams.

1. Run `bun .codex/skills/verify-agent-runtime/scripts/verify-agent-runtime.mjs health`. It rejects a missing or stale server bundle or runtime contract before checking `/health`.
2. Run `check` for the focused AgentService and event tests, changed verification, and fast lint.
3. Run `inspect` before and after a live proof. Read the JSON only. Do not print `ports.json`.
4. Run one confirmed live scenario per available provider and model. Provider availability does not prove that its account is logged in. Record authentication failures as blocked provider evidence, not application failures. Use `completion` first, then `stop`. The stop proof requires `agent.activeCount` to clear while `agent.listRunning` retains the matching cancelled snapshot for reconnect hydration. Pass `--confirm-provider-call`; the command will create and normally delete one direct thread.
5. Inspect the receipt and timeline paths from `live`. Use `$electorn-live-testing` for desktop visual confirmation. Do not duplicate Electron control here.
6. Run `cleanup` when you no longer need harness evidence. Report skipped providers, unavailable models, failed proofs, and the coverage gaps in `references/features/README.md`.

The harness never starts or stops a runtime. Each live proof uses one shared 120-second deadline, set before it creates a thread, following `scripts/providers/codex/codex-live-verify.mjs`; its 15-second health deadline follows `scripts/dev-web.mjs`.

Read `references/features/README.md` before planning a regression pass. Read its linked feature file when you verify that area.
