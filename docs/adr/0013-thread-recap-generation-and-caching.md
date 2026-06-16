---
status: proposed
---

# The thread recap is generated lazily by a stateless RPC and cached in memory per thread, never persisted

## Context

The thread [[Overview]] surfaces a **Recap** - a short AI-generated one-line
"what you're working on" for the active thread. The user's one hard constraint
was that it must not spam the model or waste tokens.

A sibling fork in this codebase's lineage (Synara, by Emanuele-web04 - same
monorepo shape, same thread / turn / provider / worktree / handoff model,
rebranded and since diverged) has already shipped exactly this feature, fully
cost-controlled. Its trigger and caching model is the prior art this decision
adapts. Synara's own divergences from us - a `gpt-5.4-mini` text-generation
default and a client-side `localStorage` cache - are noted below where they are
deliberately not followed.

The app already has one durable AI-text feature, the diff [[Summary]]
(`diff_summaries` table + `diffSummary.*` RPC via `UtilityCompletionService`).
The open question was whether the recap should live the same way. It should not:
the diff summary is a **durable record** of what a branch did (expensive to
recompute over a large diff, user-triggered), whereas the recap is **ephemeral
live UI** (cheap to recompute, useful only while on screen). Treating them as the
same class was the wrong instinct.

## Decision

The recap is **generated lazily by a stateless server RPC and cached in memory
per thread; it is never persisted.**

**Generation - stateless RPC.** A new `recap.generate`-style RPC runs the
`UtilityCompletionService` (our cheap utility model, not Synara's
`gpt-5.4-mini`) over bounded conversation material and returns the recap text.
The server **stores nothing**: no `recaps` table, no migration, no thread-row
field. This is the deliberate divergence from the diff [[Summary]], which does
persist server-side.

**Caching - in memory, per thread, client-side.** The client store keeps a
`recapByThread` map of `{ text, signature, coveredMessageId }`, held for the
session and **not persisted**. `clearThread` drops the entry. On restart the map
is empty, so the first panel-open per thread regenerates once - one cheap call,
the only cost of not persisting, and accepted.

This places the recap in the same family as **ADR-0011** (review default view)
and **ADR-0012** (panel container state): per-thread, in-memory, resets on
restart. It does **not** join the diff summary's durable-table family.

**Trigger - lazy, gated, debounced (adapted from Synara).** A client hook owns
all of it; generation is an opt-in side effect of the open panel, never wired
into the transcript render or turn-event hot path:

- **Panel-gated.** Generates only while the [[Overview]] is open. Never opened ->
  never a single call.
- **Idle-debounced.** Fires only after the thread goes quiet - ~12s before the
  first recap, ~35s before a refresh. Every new message resets the clock. Nothing
  fires mid-turn or while the assistant is streaming.
- **Signature staleness.** A cheap hash of `[last message id, role, length, turn
  state, pending flags]` gates the call; it is skipped when the signature matches
  the cached, in-flight, or last-failed value. Only **user and assistant**
  messages advance the signature - tool and work-log noise never trigger a
  regenerate.
- **Incremental delta.** After the first recap, only the new messages since
  `coveredMessageId` (bounded - last ~4, ~600 chars each) plus the previous
  recap text are sent; the prompt instructs the model to return the previous
  recap unchanged when nothing meaningful changed.
- **Bounded input.** First pass ~6 messages, hard char caps per section, output
  clipped to ~220 chars, utility model at low reasoning effort.

## Considered Options

- **Persist server-side, mirroring the diff `Summary` (`recaps` table + RPC).**
  Rejected. The recap is ephemeral live UI, not a durable record; durable storage
  buys only "skip one regeneration per thread per restart" - a single cheap call
  - while costing a table, a migration, and server-held state. This was the first
  recommendation; product feedback ("do we need to save it given it changes?")
  correctly pushed it down a tier.
- **Persist client-side in `localStorage` (Synara's actual choice).** Rejected.
  Same marginal gain (survive restart) at the cost of serialization, an
  LRU-eviction policy (Synara caps at 80 threads), and showing stale recap text
  on the first paint after restart. Not worth it for a single-install desktop app
  with no cross-device sync to gain.
- **No cache - regenerate on every panel open.** Rejected. Opening the Overview N
  times would cost N generations - exactly the token spam being designed out.
- **Eager generation (per turn, or in the background).** Rejected by the core
  token constraint: it would fire for threads no one inspects and on every turn.
- **Full re-summarize each time (no delta).** Rejected. Re-reading the whole
  transcript on every refresh wastes tokens; the incremental delta plus
  previous-recap passthrough is strictly cheaper and more stable.

## Consequences

- A new **stateless** `recap.generate`-style RPC takes bounded material plus the
  previous recap and returns text via `UtilityCompletionService`. The RPC
  contract and the client store shape are the costly-to-reverse part of this
  decision.
- The client store gains an in-memory `recapByThread` map (`text`, `signature`,
  `coveredMessageId`), not persisted, dropped by `clearThread` - mirroring the
  ADR-0011 / ADR-0012 cleanup discipline.
- A client hook (mirroring Synara's `useThreadRecap`) owns the panel-gate, idle
  debounce, signature staleness, and delta assembly. It must stay an opt-in side
  effect of the open panel and must not run from the transcript render or
  turn-event path.
- The recap reuses the diff summary's `UtilityCompletionService` call path but
  **not** its storage - a deliberate split: two AI-text features cache at
  different tiers because one is a durable record and the other is ephemeral UI.
  A future reader should not "unify" them onto one table.
- The recap prompt and model are ours (utility model, low effort), not Synara's
  `gpt-5.4-mini`; the prompt is adapted, not copied.
- On restart the first Overview open per thread regenerates once. Acceptable, and
  consistent with ADR-0011's accepted "resets on restart" trade-off; revisit only
  if it grates.
