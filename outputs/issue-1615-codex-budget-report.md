# Issue 1615 implementation budget report

> **PARTIAL** · **BALANCED** · Generated 2026-09-06T15:58:10.839Z

## Outcome

The implementation and focused checks pass. Electron user-POV proof captured supported and unsupported picker switching, Full Access completion and reopen, and a real Auto Codex approval review with one persisted Approved result. Human escalation, managed-required policy, and stop or timeout outcomes have focused automated proof but no live provider proof.

**Objective:** Implement approval-review mode safety, provider-aware Composer choices, and verifier coverage for issue 1615.

## Budget contract

### Scope

- Composer access controls
- Codex review event mapping
- review footer projection
- focused verifier map and journeys

### Restrictions

- No commits, pushes, issue edits, or repository-wide checks
- Fixture workspace only for runtime verification

### Verification floor

- Focused provider, server, and web tests
- Focused type checks and targeted lint
- Runtime health plus user interaction, capture, and persistence checks

**Stop condition:** Finish focused implementation after fixture user-POV proof, remove only owned fixture threads, and report provider-policy gaps from observed evidence.

## Work completed

| Phase | Expected usage | Status | Result |
|---|---|---|---|
| Requirement and upstream inspection | LOW | COMPLETE | Confirmed existing policy machinery and read the pinned Codex source. |
| Implementation | MEDIUM | COMPLETE | Added provider-aware choices, strict routing notice controls, Full Access suppression, bounded native review mapping, and focused tests. |
| Verification-system maintenance | LOW | COMPLETE | Updated the approval-review feature map and cross-surface journey. |
| Runtime and desktop verification | MEDIUM | PARTIAL | Captured provider-aware picker switching, durable Full Access behavior, and a real Auto Codex approval review with one persisted Approved result. Rebuilt the final runtime bundle and passed runtime health. Human escalation and managed-policy paths were not available for live proof. |

### Evidence

- **Requirement and upstream inspection:** .opensrc/repos/github.com/openai/codex/main at ac192cd7937b0d73edc6dffe009940ae53782dd4
- **Requirement and upstream inspection:** apps/server/src/features/agents/turns/__tests__/approval-review-policy.test.ts
- **Implementation:** apps/web/src/features/conversation/composer/ComposerOptionControls.tsx
- **Implementation:** packages/providers/src/private/codex/codex-event-mapper.ts
- **Implementation:** apps/web/src/features/conversation/narrative/TurnFooter.tsx
- **Verification-system maintenance:** .agents/skills/verify-mcode/references/features/provider-events-and-durability.md
- **Verification-system maintenance:** .agents/skills/verify-mcode/references/features/multi-surface-journeys.md
- **Runtime and desktop verification:** .dev/verification/issue-1615/codex-three-options.png
- **Runtime and desktop verification:** .dev/verification/issue-1615/claude-two-options-after-switch.png
- **Runtime and desktop verification:** .dev/verification/issue-1615/full-access-completed.png
- **Runtime and desktop verification:** .dev/verification/issue-1615/full-access-reopened.png
- **Runtime and desktop verification:** .dev/verification/issue-1615/auto-approved-final.png
- **Runtime and desktop verification:** .dev/verification/issue-1615/auto-reopened-final.png

## Verification

| Command or check | Result | Detail |
|---|---|---|
| `bun run --cwd packages/providers test -- src/__tests__/codex/codex-event-mapper.test.ts` | PASS | 115 tests passed; strict routing, stale and duplicate rejection, Full Access suppression, redaction, and one review terminal result for completed, failed, and interrupted native turns. |
| `bun run --cwd apps/web test -- src/transport/ws-events.test.ts src/features/conversation/composer/controls/__tests__/ComposerAccessControls.test.tsx src/features/conversation/messages/__tests__/canonical-message-projection.test.ts src/features/conversation/narrative/__tests__/TurnFooter.test.tsx` | PASS | 34 tests passed before the final strict-notice ingress assertion. The affected ws-events suite was rerun after that edit and passed 13 tests. |
| `Owned Electron user-POV capture` | PASS | Codex showed Manual, Auto, and Full access. Claude Haiku showed Manual and Full access after a provider switch. A Full Access turn reopened without review labels. A real Auto Codex fixture turn emitted one command and one approval review, showed one Approved result and the Automatic approval review selected footer, and reopened with one persisted Approved result. |
| `Public fixture thread cleanup check` | INCONCLUSIVE | Authenticated public RPC resolved exactly the fixture-repo workspace and returned zero active threads. Two owned completed threads had been visible in Electron before it stopped, so this does not prove their deletion or absence. No delete request was issued; the fixture repository status remained clean. |
| `bun run --cwd apps/server test -- src/features/agents/turns/__tests__/approval-review-policy.test.ts` | PASS | 3 tests passed; fallback and managed-required blocking covered. |
| `bun run --cwd packages/providers typecheck; bun run --cwd apps/web typecheck` | PASS | Both changed workspaces passed TypeScript checking. |
| `git diff --check` | PASS | No whitespace errors. |
| `bun run lint -- <changed provider and web source/test files>` | PASS | Targeted oxlint passed after building the repository oxlint plugin. |
| `bun .agents/skills/verify-mcode/scripts/verify-mcode.mjs runtime health` | PASS | Runtime health passed after direct awaited rebuildServerDevBundle and agent restart. |
| `bun run --cwd apps/server test -- src/features/agents/orchestration/__tests__/agent-service-turn-started.test.ts` | PASS | 2 tests passed; dispatch and persisted effective permission and approval-review fields agree. |

## Usage measurement

**Measurement:** UNAVAILABLE

The host did not expose account-level usage snapshots, so this report makes no token or percentage claim.

**Start snapshot:** Not available.

**End snapshot:** Not available.

> Account-level snapshots may include rounding, caching, delayed reporting, or activity from other tasks. They are not exact task-level token measurements.

## Deferred work

- **Owned fixture-thread cleanup:** The public API returned zero active rows after Electron stopped, but this cannot establish removal of the two completed threads visible immediately before shutdown. No deletion was performed.
- **Live human escalation and managed-required policy:** The Auto provider run approved automatically, and no managed provider policy was available. Strict routing and managed-required blocking have focused automated coverage.
- **Live stop, provider-failure, timeout, and stale-retry outcomes:** Focused mapper tests cover one terminal result and stale or duplicate rejection. No provider run exposed each terminal path during this fixture session.
- **Repository-wide lint and test suite:** Outside the focused Balanced budget and repository instructions.

## Notes

- The first runtime rebuild exposed an incomplete generated drizzle directory. The existing rebuildServerDevBundle function regenerated it without product-code changes, after which runtime health passed.
- Acceptance mapping: focused tests cover supported and unsupported picker choices and switching, strict notice versus real permission ingress, fallback and managed blocking, Full Access suppression, stale and duplicate review events, native timeout, and single review terminal closure for completed, failed, and interrupted turns. Electron captures prove picker switching, Full Access reopen, and Auto approval review persistence.
- The final public cleanup check found zero active fixture threads after the owned Electron session stopped. Because two completed owned threads had been visible before shutdown, the result is inconclusive. No delete request was issued, and the fixture repository stayed clean.
