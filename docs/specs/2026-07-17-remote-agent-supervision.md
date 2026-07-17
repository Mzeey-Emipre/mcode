# Remote Agent Supervision

**Date:** 2026-07-17
**Status:** Research proposal
**Research:** [Codex app feature audit PR #861](https://github.com/Mzeey-Empire/mcode/pull/861)

## Problem

Agent work often outlasts a desk session. A user may need to answer a plan question, approve a bounded action, inspect a diff, or stop a failing run from another device. Exposing Mcode's desktop server or terminal directly would turn convenience into remote shell access without an adequate identity, authorization, or audit model.

## Product outcome

Research a read-first remote companion for supervising an existing Mcode host. A paired client can inspect thread status, narration, pending questions, diffs, tests, terminal snapshots, and verification screenshots. Mutations are limited to follow-up messages, answers, interrupt, and individually confirmed approvals. Remote shell input, arbitrary file writes, Git pushes, and host administration remain out of scope.

## Goals

- Pair one mobile or desktop client to a named Mcode host with short-lived credentials.
- Show active threads, attention states, current worktree, provider, elapsed time, and recent evidence.
- Answer agent questions, send a follow-up, interrupt a turn, or approve one bounded request.
- Inspect sanitized diffs, test results, terminal snapshots, and screenshots.
- Reconnect without duplicating actions or losing approval attribution.

## Non-goals

- A general remote desktop or SSH replacement.
- Starting an arbitrary shell or typing into terminals.
- Browsing the host filesystem outside artifacts already exposed by a thread.
- Silent approvals, blanket approval sessions, commit, push, merge, deployment, or credential management.
- Internet exposure of the existing local development server.

## Pairing and sessions

Pairing begins on the trusted host and displays a short-lived QR code plus a human-readable host name and fingerprint. The client confirms the fingerprint and the host confirms the client identity. Pairing creates a revocable device record, not a permanent bearer URL.

Each remote session has an expiry, inactivity timeout, last-seen time, device identity, network path, and capability set. The host lists paired devices and active sessions with Revoke controls. Revocation terminates active connections and invalidates queued mutations.

Remote transport must provide mutual authentication, forward secrecy, replay protection, sequence integrity, and end-to-end encryption between the paired client and host. Relay infrastructure, if used, sees routing metadata and ciphertext only.

## Read model

The client receives bounded projections rather than direct database, WebSocket, terminal, or filesystem access. A thread projection may contain:

- identity, title, project, worktree, provider, model, and state;
- current plan and recent narration;
- pending user question or approval request;
- changed-file summary and a requested bounded diff;
- test and verification receipts;
- user-requested terminal snapshots and screenshots.

Secrets, hidden prompts, raw provider payloads, protected environment values, and unbounded logs are excluded. Remote data is cached only for the active session unless the user explicitly saves an artifact on the client.

## Mutation rules

Each remote mutation names the host, thread, worktree, requesting agent, exact effect, expiry, and idempotency key. The host revalidates current state before applying it.

- **Answer** responds to one outstanding question.
- **Follow up** queues a user-authored message under normal thread rules.
- **Interrupt** stops the selected running turn without closing the thread.
- **Approve once** accepts one displayed tool request with unchanged arguments before its expiry.
- **Deny** rejects one displayed request.

An approval becomes stale if tool arguments, worktree, thread, provider turn, host identity, or repository state changes. Remote clients cannot widen permissions or approve administrator prompts.

## Offline, reconnect, and host-loss behavior

- Read actions may show a timestamped cached snapshot marked offline.
- Mutations remain unsent while offline and require reconfirmation after reconnect.
- Reconnect resumes from a monotonic event cursor and deduplicates by idempotency key.
- If the host restarts, active approvals expire and in-flight outcomes become known, rejected, or unknown after reconciliation.
- Unknown outcomes block repeat mutation until the host refreshes authoritative state.
- A lost or stolen client can be revoked from the host, and a host reset invalidates all device records.

## Acceptance criteria

1. Pairing requires confirmation on both host and client and produces inspectable device records.
2. The remote client can inspect active work and bounded evidence without local-server, database, shell, or filesystem access.
3. Supported mutations are limited to answer, follow-up, interrupt, approve once, and deny.
4. Every mutation is attributable, expiring, idempotent, and revalidated against current host state.
5. Permission widening, remote shell input, external Git writes, and administrator approval are unavailable.
6. Offline clients cannot queue approvals or other mutations for later silent execution.
7. Reconnect does not duplicate messages, interrupts, approvals, or denials.
8. Revoking a device terminates its sessions and prevents future use.
9. Relay operators cannot read thread content or approval payloads.
10. Security review and threat modeling are required before an implementation milestone is accepted.

## Verification protocol

- Threat-model pairing, relay compromise, stolen clients, replay, host impersonation, stale approvals, and malicious thread content.
- Contract-test authentication, capability checks, bounds, expiry, idempotency, and state revalidation.
- Pair a test client, inspect one running thread, answer a question, and interrupt a later turn.
- Disconnect during an approval, reconnect, and confirm the request requires a fresh decision.
- Revoke the client and confirm cached credentials cannot reconnect.
- Inspect relay traffic and logs to confirm content remains encrypted and secrets absent.
- Run `bun run verify` after any prototype reaches repository code.

## Repository anchors

- `packages/contracts`
- `apps/server/src/services/agent-service.ts`
- `apps/server/src/services/terminal-service.ts`
- `apps/server/src/ws`
- `apps/electron`

## Reference behavior

OpenAI documents paired mobile and desktop supervision, follow-ups, questions, approvals, diffs, tests, terminal output, screenshots, notifications, and SSH host discovery in [Remote connections](https://learn.chatgpt.com/docs/remote-connections). Mcode should keep remote supervision separate from any later SSH or host-handoff design.
