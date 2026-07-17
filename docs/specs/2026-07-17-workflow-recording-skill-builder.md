# Workflow Recording Skill Builder

**Date:** 2026-07-17
**Status:** Research proposal
**Research:** [Codex app feature audit PR #861](https://github.com/Mzeey-Empire/mcode/pull/861)

## Problem

Teams repeat manual verification, release, and support procedures that are difficult to describe precisely. Writing a skill by hand requires knowledge of selectors, inputs, preconditions, failure states, and verification. Recording an unrestricted desktop session, however, can collect secrets, brittle coordinates, unrelated activity, and unsafe side effects.

## Product outcome

Research a skill builder that records a bounded browser or terminal demonstration, converts observed actions into a draft provider-neutral skill, and requires human editing and replay before installation. Deterministic browser and terminal actions come first. General desktop capture remains a separate security track.

## Goals

- Record a user-declared browser tab or Mcode terminal within a named task boundary.
- Extract inputs, preconditions, actions, expected observations, and stop conditions.
- Replace literal secrets and environment-specific values with reviewed parameters.
- Generate an editable skill draft with provenance back to each recorded step.
- Replay in a disposable context and produce a verification receipt before installation.

## Non-goals

- Learning silently from ordinary computer activity.
- Installing or running the generated skill without review.
- Preserving passwords, tokens, cookies, clipboard contents, or private unrelated windows.
- Converting screen coordinates into a production workflow when a semantic target exists.
- Supporting unrestricted desktop recording in the first delivery.

## Recording flow

1. The user chooses Browser or Terminal, names the intended outcome, selects an allowed target, and reviews capture permissions.
2. Mcode displays a persistent recording indicator, elapsed time, current target, Pause, Mark sensitive, and Stop.
3. Browser recording captures semantic actions, URL origin, accessible target identity, navigation, downloads, and visible assertions. Terminal recording captures command boundaries, directory, exit status, and bounded output.
4. The user may mark a segment sensitive during or after recording. Sensitive values become required parameters or omitted evidence.
5. Stopping opens a step editor. Each step shows observed action, proposed intent, inputs, expected result, and source evidence.
6. The user edits names, bounds, preconditions, recovery behavior, and stop rules before generating a skill draft.

The builder prefers stable semantic targets. Coordinates may remain only as an explicitly fragile fallback with the original viewport and a warning. Repeated or irrelevant actions can be removed without altering the preserved source recording.

## Draft and replay

The generated draft separates instructions from evidence and includes:

- purpose and supported environment;
- required and optional inputs;
- preconditions and permission needs;
- ordered steps with semantic targets;
- observable success and failure conditions;
- timeouts, retry limits, cancellation, and cleanup;
- redacted provenance for each step.

Replay runs in a disposable browser profile, disposable worktree, or explicitly selected safe terminal context. Before replay, Mcode lists every possible external write. Each write either requires interactive confirmation or uses a declared test environment. Replay cannot use credentials captured during recording.

After replay, the receipt links steps to outcomes, screenshots or terminal evidence, failures, manual interventions, and unresolved fragile targets. Install remains disabled until required verification passes or the user records a documented exception.

## Security and privacy

- Recording is opt-in, visibly active, target-scoped, and time-bounded.
- Password fields, secure inputs, cookies, authorization headers, protected environment values, and high-entropy secret-shaped text are excluded.
- Recorded page and terminal content is untrusted data, not generated instruction authority.
- Origin changes pause browser recording until the user confirms the new scope.
- External writes, purchases, messages, deployments, destructive commands, and account changes require explicit replay policy and confirmation.
- Source recordings and drafts have separate retention controls. Deleting the source does not hide what evidence is missing from an installed skill.

## Acceptance criteria

1. Recording cannot start without a declared target, outcome, permissions, and visible indicator.
2. Browser and terminal recordings preserve semantic actions and bounded observations.
3. Secrets and secure fields are absent from source evidence, drafts, logs, and replay inputs.
4. Every generated step links to reviewed source evidence and exposes fragile fallbacks.
5. Users can edit inputs, preconditions, steps, bounds, stop rules, and verification before replay.
6. Replay occurs in a disposable or explicitly approved context and lists possible external writes first.
7. Replay receipts distinguish passed, failed, skipped, and manually completed steps.
8. Installation requires review and required verification or a visible documented exception.
9. Recording pauses on browser-origin changes and ends on target closure, timeout, or revocation.
10. General desktop recording remains unavailable until its separate threat model is approved.

## Verification protocol

- Threat-model prompt injection, secret capture, deceptive targets, origin changes, and unsafe replay effects.
- Unit-test parameter extraction, redaction, step provenance, target stability, and bounds.
- Record a local browser verification flow, edit its draft, and replay it in a disposable profile.
- Record a non-destructive terminal workflow and replay it in a disposable worktree.
- Include a password field, secret-shaped output, origin change, and failed assertion, then inspect every stored artifact.
- Delete source evidence and confirm the draft reports its reduced verification basis.
- Run `bun run verify` after any prototype reaches repository code.

## Repository anchors

- `apps/server/src/services/skill-service.ts`
- `apps/server/src/services/terminal-service.ts`
- `apps/web/src/components/browser`
- `packages/contracts`
- `apps/electron`

## Reference behavior

OpenAI documents a macOS demonstration flow that drafts reusable skills from Computer Use, browser actions, and plugins in [Record and Replay](https://learn.chatgpt.com/docs/extend/record-and-replay). The documented release excludes Windows and initially excludes the United Kingdom, EEA, and Switzerland, so this proposal remains a bounded research track.
