# Hybrid Memory Broker

**Date:** 2026-07-17
**Status:** Proposal
**Tracking issue:** [#875](https://github.com/Mzeey-Empire/mcode/issues/875)
**Research:** [Provider memory capability research](../research/2026-07-17-provider-memory-capabilities.md)
**Origin:** [Codex app feature audit PR #861](https://github.com/Mzeey-Empire/mcode/pull/861)

## Problem

Mcode can move a Thread between Providers through a Handoff, but each Provider may also load its own memories, instructions, and session context. Those sources have different scopes and controls.

Another automatic memory system could inject stale or conflicting guidance. Users need explicit facts and preferences that cross Providers without becoming hidden context.

## Product outcome

Add a hybrid memory broker that keeps Provider memory provider-owned and adds local, reviewable Mcode portable memory. Mcode discloses Provider memory without importing it. Portable memory crosses Providers only after user acceptance.

## Source model

Mcode presents two distinct sources:

1. **Provider memory** is owned by its Provider. Mcode never reads, copies, edits, merges, or exports it without a documented Provider API.
2. **Portable memory** is owned by Mcode. It contains user-approved statements with Mcode provenance and may be supplied to any compatible Provider selected for the Thread.

Mcode reports Provider memory as active only when runtime evidence proves it. Documentation may support “available, status unknown,” never an active claim.

## Native capability handshake

Each Provider adapter reports version-gated capabilities for detecting use, controlling recall or contribution, exposing citations, opening management, and resetting data. Each is supported, unavailable, or unknown. Runtime state remains separate.

Native controls require live verification and retain Provider terminology and confirmations. Destructive reset remains Provider-specific.

## Portable-memory lifecycle

Portable memories are never learned silently. A user creates a candidate by:

- saving a selected user statement, assistant result, or verified command;
- entering a statement directly; or
- explicitly requesting suggestions from an eligible part of a completed Thread.

Suggestions use the current Provider in an identified, bounded side-channel and enter review. Manual creation remains available.

Each candidate records class, scope, source Turn, evidence, creation Provider, and review rule. Acceptance creates an immutable revision. Editing creates another revision.

## Memory classes and scopes

| Class | Example | Default scope | Review trigger |
| --- | --- | --- | --- |
| Preference | Preferred verification style | User | User changes it |
| Project fact | Runtime ports come from the runtime manifest | Workspace | Cited source changes |
| Verified command | Command that started the local runtime | Workspace | Command fails or source changes |
| Temporary observation | Current migration is blocked | Thread | Required expiry |

Scopes are Thread, Workspace, and User. A Provider restriction limits delivery without granting access to native memory.

## Turn contract

Before dispatch, the broker resolves accepted revisions by scope, staleness, exclusions, Thread settings, conflicts, and byte budget. The envelope is immutable for the logical Turn and every retry.

The Turn request carries the envelope separately. Each adapter reports its documented delivery mode. Without one, portable memory is unavailable.

Mcode persists one Turn context receipt containing:

- the user message and Provider identity;
- each portable memory ID and immutable revision;
- a hash of the rendered envelope;
- the delivery mode and dispatch state;
- exclusions and reasons;
- runtime disclosure and citations available for Provider memory; and
- references to known instructions, resumed history, and Handoff context.

Only portable memory stores exact revisions. Other sources receive observable references, hashes, or unknown markers. Provider memory is never copied.

## Precedence and conflicts

Current instructions and checked-in guidance remain authoritative. Portable memory cannot grant permissions, approve tools, install Hooks, change settings, or weaken sandbox rules.

Source changes make related memory stale. Conflicting portable memories are excluded for review rather than sent to the model. Mcode cannot enforce precedence over opaque Provider memory, and the UI states that limitation.

## Provider switching and Handoffs

Portable memories resolve independently for the destination Provider's next Turn. Handoffs omit them. A switch preview shows what can cross and warns that Provider memory stays behind.

Returning may reactivate native memory. Mcode records only its portable envelope.

## User experience

The composer shows included portable-memory count and Provider-memory disclosure. Its inspector reveals text, scope, source, revision, exclusions, and one-Turn controls.

Settings owns every record state. Revision, Provider, scope, and time use monospace. Actions have keyboard paths; Filament Amber marks selection or the primary action.

Each Thread has **Use portable memories**, off by default. Suggestions remain explicit. Provider switching and Turn receipts link to the same inspector.

## Security, privacy, and bounds

- Portable-memory storage and review state stay in Mcode's local data directory.
- Secret-shaped candidates fail closed before storage. Rejected text does not enter logs, analytics, exports, or Provider context.
- Memory content is untrusted data. It cannot affect permissions or tool approval.
- Each statement is capped at 2 KiB and each evidence excerpt at 8 KiB.
- A Turn may receive at most 16 portable revisions and 12 KiB of rendered portable context.
- Candidate and rejected queues are bounded; accepted records are never evicted automatically.
- Export includes portable records and receipts only. Provider-owned memory is excluded.
- Deleting a source Thread removes candidates and asks whether linked accepted memories should be deleted or kept with unavailable provenance.

## Acceptance criteria

1. Provider memory and Mcode portable memory appear as separate named sources.
2. Mcode never imports or represents the contents of Provider memory without a documented integration contract.
3. Every Provider reports native capabilities separately; active status and controls require runtime evidence.
4. No portable candidate is created without an explicit user action.
5. No candidate reaches another Thread or Provider before user acceptance.
6. Every accepted memory has immutable revision, class, scope, source, evidence, reviewer action, and review trigger.
7. Users can create, inspect, edit, accept, reject, exclude, mark stale, delete, and export portable memories.
8. **Use portable memories** is off by default and can be changed per Thread.
9. The exact resolved envelope is fixed before dispatch and reused on automatic retry.
10. Every dispatched Turn has a source-separated context receipt with exact portable revisions and only observable references for other sources.
11. Checked-in guidance and the current prompt outrank portable memory.
12. Conflicting or stale portable memories are excluded before Provider dispatch.
13. Provider switching previews portable continuity and warns that native memory does not cross.
14. Portable memory is resolved separately from the Handoff document.
15. Secret-shaped candidates fail closed and leave no recoverable text in normal application data.
16. Context, record size, queue length, suggestion work, and storage are bounded.
17. The complete workflow is keyboard accessible and remains usable in narrow and wide layouts.

## Verification protocol

The primary seam is a completed Turn against a recording Provider adapter and real local database. The Provider request and persisted receipt must describe the same immutable envelope.

- Unit-test lifecycle transitions, revisioning, scope matching, stale-source detection, conflict exclusion, secret rejection, and byte budgets.
- Contract-test each Provider adapter's portable-context delivery and native-memory disclosure.
- Integration-test explicit save, explicit suggestions, review, one-Turn exclusion, automatic retry, Provider switching, export, and deletion.
- Verify that retries reuse the original revisions even if memory changes while the first attempt is in flight.
- Verify that a Handoff omits portable memory and the destination Turn resolves it once.
- Verify that an opaque Provider never produces a false “active memory” status.
- Inspect the composer, review queue, Turn receipt, and switch preview live in both themes and at narrow and wide widths.
- Run `bun run verify` after the live checks.

## Non-goals

- Replacing or synchronizing Provider-native memory.
- Reading private Provider files or cloud memory stores.
- Automatically accepting model-generated memories.
- Background transcript mining.
- Cloud sync, shared team memory, organization policy, or account-level administration.
- Replacing `AGENTS.md`, `CLAUDE.md`, Provider rules, `CONTEXT.md`, ADRs, Skills, Hooks, or Handoffs.
- Guaranteeing precedence over context injected internally by a Provider.

## Repository anchors

- Provider and Turn contracts
- Agent orchestration and retry
- Thread settings and Provider-switch Handoffs
- Local data repositories and schema
- Composer, Settings, and narrative timeline
