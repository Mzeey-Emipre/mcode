# Scheduled Agent Runs and Attention Inbox

**Date:** 2026-07-17
**Status:** Proposal
**Tracking issue:** [#873](https://github.com/Mzeey-Empire/mcode/issues/873)
**Research:** [Codex app feature audit PR #861](https://github.com/Mzeey-Empire/mcode/pull/861)

## Problem

Mcode can supervise long-running work, but every run begins with a person in the composer. Routine checks such as dependency audits, issue triage, release preparation, and test monitoring cannot run on a schedule. Users also lack one place to review unattended results and distinguish useful findings from failures or requests for attention.

## Product outcome

Add an Automations surface for recurring and one-time agent runs. Each code-changing run starts in an isolated worktree, records its provider and permission policy, and produces a reviewable receipt. An Attention inbox gathers unread results, failures, approval requests, and completed work without posting, committing, pushing, or opening pull requests automatically.

## Goals

- Schedule a prompt against a project with a provider, model, recurrence, permission profile, and outcome rule.
- Support a fresh thread per run or a recurring turn in one dedicated thread.
- Keep unattended code changes isolated from the workspace checkout.
- Make each run understandable through status, logs, diff, cost, duration, and stop reason.
- Let users pause, resume, run now, edit, duplicate, and delete schedules.

## Non-goals

- A general operating-system task scheduler.
- Silent remote Git or project-management writes.
- Guaranteed delivery while the host is asleep or Mcode is stopped.
- Cross-machine execution in the first delivery.

## User experience

The Automations view separates Active, Paused, Needs attention, Completed, and Recent runs. A schedule row shows its project, next run, last outcome, provider, and unread state. Opening it reveals the prompt, recurrence, permission boundary, run history, and worktree policy.

The editor accepts a local time and common recurrence choices, with an advanced RRULE field for schedules that need it. Before save, Mcode previews the next three run times in the user's current time zone. Invalid or impossible recurrences stay unsaved.

Each run creates a receipt containing:

- schedule and run identity;
- actual start and finish times;
- provider, model, permission profile, and resolved project revision;
- thread and worktree links;
- outcome, stop reason, token or cost data when available;
- bounded logs, changed files, test evidence, and pending approvals.

Unread receipts appear in the Attention inbox. Marking an item read does not accept its changes. Continue opens the run thread. Review changes opens its Review surface. Discard removes only the managed run worktree after the user sees what will be lost.

## Execution and recovery rules

- Code-changing schedules default to a new managed worktree per run.
- Read-only schedules may use the project checkout only when their permission profile cannot write.
- One schedule cannot overlap itself by default. A user may choose queue-latest or skip-latest, but not unbounded concurrency.
- A missed run records why it was missed. Mcode does not replay a backlog without an explicit policy.
- Startup resumes only runs whose provider session supports safe reconnection. Others become interrupted receipts.
- A budget, duration, queue depth, retained-run count, and retained-log size are required for every schedule.
- Retries create distinct attempts under one run and stop at the configured limit.

## Trust and permission boundaries

Scheduled prompts, repository files, plugin output, and provider events are untrusted input. The schedule stores a named permission profile rather than inheriting a future global setting. Increasing permissions, adding a plugin, enabling a remote write, or changing the target project requires explicit confirmation.

No unattended run may commit, push, open or update a pull request, post a comment, merge, publish, deploy, or approve an external request. Those effects remain pending actions in the receipt. Secrets stay in the existing protected environment boundary and never appear in prompts, logs, notifications, or receipts.

## Acceptance criteria

1. A user can create, preview, edit, pause, resume, run now, duplicate, and delete a schedule.
2. The schedule supports fresh-thread and recurring-thread execution modes.
3. Code-changing runs use isolated worktrees and never alter the workspace checkout.
4. The system prevents unbounded overlap, retries, runtime, log retention, and worktree retention.
5. Run receipts expose outcome, evidence, cost when available, and links to the exact thread and worktree.
6. Needs-attention states include failure, interrupted execution, pending approval, and completed changes.
7. A missed or interrupted run has an explicit reason and recovery action.
8. No external write occurs without a later user confirmation.
9. Recurrence rendering remains correct across time-zone changes and daylight-saving transitions.
10. Keyboard and screen-reader users can manage schedules and review receipts.

## Verification protocol

- Unit-test recurrence parsing, time-zone transitions, overlap policies, retry limits, retention, and state transitions.
- Integration-test worktree isolation, permission snapshots, interrupted-run recovery, and forbidden remote effects.
- Run a short one-time read-only schedule and observe its receipt.
- Run a code-changing schedule and confirm the workspace checkout remains unchanged while Review shows the isolated diff.
- Restart Mcode during a run and confirm the resulting state is either reconnected or explicitly interrupted.
- Run `bun run verify` after the live checks.

## Repository anchors

- `apps/server/src/services/agent-service.ts`
- `apps/server/src/services/worktree-service.ts`
- `apps/web/src/stores/threadStore.ts`
- `packages/contracts`
- `apps/electron`

## Reference behavior

OpenAI documents local-project and isolated-worktree schedules, recurring rules, run history, and unattended permission risks in [Scheduled tasks](https://learn.chatgpt.com/docs/automations). The saved reference image is in audit PR #861.
