# Status: PASS

## Objective

Implement provider-neutral automatic approval review for Codex. Persist the
resolved decision, show the live and settled review states, and verify the
public Composer, reconnect, and Electron paths.

## Budget contract

- Mode: BALANCED
- Scope: approval-review contracts, provider adapter, dispatch policy,
  Composer selection, persistence, and the provider-events verifier journey.
- Restrictions: no commits, pushes, runtime or tool installs, database resets,
  or repository-wide checks.
- Verification floor: focused behavior tests, scoped lint and typechecks,
  runtime health, migration inspection, a public automatic request, and visual
  Electron evidence.

## Delivered behavior

- The existing finite provider capability descriptor exposes approval review to
  the Composer. One Access mode selector maps Supervised to manual review, Auto
  to automatic review, and Full access to manual review. Its selected Lucide
  icons are Eye, ShieldCheck, and KeyRound. The Composer has no Codex-specific
  capability branch.
- The server inspects support without side effects and freezes the resolved
  permission and review modes before dispatch. Managed required rules reject
  unsupported, manual, and Full Access requests. Supported Supervised automatic
  review passes.
- Codex sends `approvalsReviewer: "auto_review"` only for a frozen automatic
  request. The observed predicate requires Codex 0.153.4, the experimental
  protocol schema, and an `experimentalApi: true` handshake. Other versions
  are unavailable.
- Native review started and terminal events become one bounded canonical tool
  lifecycle. Duplicate and stale terminal events are rejected.
- Migration 0059 persists the resolved mode and stable reason. Canonical
  reconnect ordering uses `accepted_sequence`, so a recovered turn retains the
  automatic footer after reload.
- Active reviews render `Reviewing`; settled reviews render one Approved or
  Denied result without a native review ID. The footer renders the readable
  resolved mode.
- The verifier journey now records Composer selection, native lifecycle,
  reconnect, screenshots, and owned-state cleanup.

## Final evidence

- Electron Composer selector screenshots, visually inspected after the unified
  selector change:
  - `.dev/verification/issue-1614-access-menu.png`
  - `.dev/verification/issue-1614-access-auto.png`
- Electron native lifecycle screenshots, visually inspected before the selector
  change. The adapter and lifecycle rendering are unchanged:
  - `.dev/verification/issue-1614-reviewing.png`
  - `.dev/verification/issue-1614-approved.png`
  - `.dev/verification/issue-1614-reopened.png`
- The final Composer proof selected Supervised, Auto, Full access, Supervised,
  then Auto. Each selection closed the menu, updated the visible trigger, and
  left no Approval review dropdown. It used the fixture project only and did
  not create a thread or turn.
- Public receipt: `outputs/issue-1614-public-reconnect-receipt.json`.
  `MCODE_REVIEW_START_1614` retained automatic mode with
  `experimental-api-enabled`, one review identity, Reviewing from
  `2026-09-06T12:47:39.113Z` to `2026-09-06T12:47:44.560Z`, and one Approved
  terminal result. The public conversation page also contained one Approved
  review.
- The receipt was collected through `push.setThreadSubscriptions` with a
  canonical revision zero and `conversation.page`, then the four owned fixture
  threads were removed through public `thread.delete`. The fixture workspace
  remains.

## Focused verification

- PASS: `bun run --cwd packages/contracts typecheck`.
- PASS: `bun run --cwd packages/providers typecheck`.
- PASS: `bun run --cwd apps/server typecheck`.
- PASS: `bun run --cwd apps/web typecheck`.
- PASS: `bun run --cwd apps/server test -- src/features/agents/turns/__tests__/approval-review-policy.test.ts src/features/agents/canonical/__tests__/canonical-agent-event-sink.test.ts src/features/providers/availability/__tests__/provider-availability-service.test.ts src/features/providers/transport/__tests__/providers-availability-rpc.test.ts` with 83 tests in 4 files.
- PASS: `bun run --cwd packages/providers test -- src/__tests__/codex/codex-event-mapper.test.ts src/__tests__/codex/codex-app-server-handshake.test.ts src/__tests__/codex/codex-version.test.ts` with 161 tests in 3 files.
- PASS: `bun run --cwd apps/web test -- src/features/conversation/composer/__tests__/composer-capabilities.test.ts src/features/conversation/composer/draft/__tests__/composer-selection-state.test.ts src/stores/__tests__/providerAvailabilityStore.test.ts src/features/conversation/messages/__tests__/canonical-message-projection.test.ts src/features/conversation/narrative/__tests__/TurnFooter.test.tsx` with 24 tests in 5 files.
- PASS: `bun run --cwd apps/web test -- src/features/conversation/narrative/__tests__/tool-row-overflow.test.tsx` with 17 tests after the active Reviewing renderer change.
- PASS: `bun run --cwd apps/web test -- src/features/conversation/composer/controls/__tests__/ComposerAccessControls.test.tsx src/features/conversation/composer/__tests__/composer-capabilities.test.ts src/features/conversation/composer/draft/__tests__/composer-selection-state.test.ts src/features/conversation/composer/submission/composer-submission-routes.test.ts` with 16 tests in 4 files after the unified selector change.
- PASS: scoped `oxlint` over the final active renderer and its test.
- PASS: scoped `oxlint` over the unified Composer selector after its final layout adjustment.
- PASS: runtime health after invoking the exported server development bundle
  builder and starting the owned runtime.
- PASS: migration 0059 review columns exist in the running worktree database.
- PASS: final `git diff --check` and focused credential scan.

## Usage measurement

Account usage measurement was unavailable. This report makes no token or
account-percentage estimate.

## Known limitation

The installed support predicate is deliberately conservative. A compatible
future Codex release remains unavailable until its schema and handshake are
observed and added to the predicate.
