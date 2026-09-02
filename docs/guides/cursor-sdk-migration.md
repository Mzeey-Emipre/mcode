# Cursor SDK Migration Handoff

> **Status: DEFERRED (2026-05-23). Scope reduced 2026-06-08.**
>
> Investigation completed 2026-05-23. The migration is on hold until the
> un-defer trigger below fires.
>
> **Update (2026-06-08): path A is gone.** Cursor's handoff no longer uses the
> hidden-turn workaround. `sessionForkOnResume` is now `"clean"` and the
> provider runs `runSideChannelQuery` by reconstructing the parent's persisted
> session into a throwaway ACP connection (loading a session id into a second
> connection branches the conversation rather than advancing the canonical
> session, so the parent is never mutated). The `MutatingForker`, `runHiddenTurn`,
> `runRawPrompt`, the settle-wait poll, the disregard turn, and the `"mutating"`
> capability have all been retired. The `LadderStep` union is now `"B" | "D"`.
> Everything below that frames this migration as a way to *remove path A* is
> therefore already done; treat that framing as historical.
>
> **What still remains** is the original swap itself: the provider still spawns
> the long-lived `cursor-agent acp` subprocess. Migrating that to `@cursor/sdk`
> remains deferred and is now a self-contained cleanup (remove subprocess
> plumbing) with no handoff-pipeline impact, since the pipeline already treats
> Cursor as a clean-fork provider.
>
> **Why deferred:** `@cursor/sdk` v1.0.13 requires an API key, either passed as
> `apiKey` per call or read from `process.env.CURSOR_API_KEY` (see
> `dist/esm/local-executor.d.ts:11` and the `Agent.get` JSDoc in the SDK
> package). It has no mechanism to read the `cursor-agent` CLI's stored login
> token. This conflicts with the project rule that mcode never requires users
> to set API keys directly, and reverse-engineering the CLI's token store is
> too fragile to commit to.
>
> **Un-defer trigger:**
>
> 1. **`@cursor/sdk` gains CLI-auth support.** If a future SDK release can
>    read the local `cursor login` token (no `CURSOR_API_KEY` env, no
>    settings entry), the migration described below becomes viable. Track
>    the SDK changelog and: https://forum.cursor.com/t/cursor-sdk-cloud-agents-api-updates/159284
>
> **Recheck on or after 2026-08-23.** To recheck:
>
> ```sh
> # @cursor/sdk gained CLI-auth support?
> npm view @cursor/sdk version   # anything newer than 1.0.13?
> npm view @cursor/sdk readme    # look for CLI-auth / cursor-login mentions
> ```
>
> If the trigger has not fired, bump this recheck date by another 3 months
> and leave the rest of the doc alone.

A persistent handoff doc for whoever picks up the Cursor provider migration
from `cursor-agent acp` subprocess to `@cursor/sdk`. Pairs with `CONTEXT.md`
and the chat-fork handoff feature shipped in PR #499 (commit `fb4e7123`).

## What this is

A focused handoff describing why this migration exists, what it will simplify
in the codebase, and how to scope and execute it. Not a plan (a plan should
be written via `superpowers:writing-plans` once this doc is read). Not
exhaustive context (cross-references the existing plan + glossary).

## What the next session should focus on

Migrate `apps/server/src/features/providers/adapters/cursor/cursor-provider.ts` from spawning
the long-lived `cursor-agent acp` subprocess to using the new TypeScript
`@cursor/sdk` package directly. Once the SDK's `Agent.resume` primitive is in
place, Cursor's `sessionForkOnResume` capability flips from `"mutating"` to
`"clean"`, and the entire path A (hidden-turn) implementation in the chat
fork handoff pipeline becomes deletable.

## Why this matters

Path A exists only because the ACP wire protocol's `session/load` is broken:
it does not send back `user_message_chunk` / `agent_message_chunk` updates
when resuming a session, so the provider loses conversation history. mcode
worked around this by injecting hidden turns directly into Cursor's mutable
session, with a 10-second settle-wait poll and a disregard-turn cleanup
step. This is a substantial amount of provider-specific complexity that
exists purely to compensate for one broken RPC method.

`@cursor/sdk` (public beta released 2026-04-29) exposes `Agent.resume` as a
first-class primitive that does restore session state correctly. Once
cursor-provider.ts uses it, the workaround infrastructure can be retired.

## Code surfaces affected

### Files to rewrite

- `apps/server/src/features/providers/adapters/cursor/cursor-provider.ts`. Replace the
  `spawn("cursor-agent", ["acp"])` subprocess plumbing, the long-lived
  process management, the JSON-RPC framing, and the session-entry state
  tracking. Use `@cursor/sdk` `Agent.create` / `Agent.prompt` / `Agent.resume`
  / `agent.send` / `run.stream` directly instead.

### Capability and method changes

- `apps/server/src/features/providers/adapters/cursor/cursor-provider.ts` declares:
  - `sessionForkOnResume = "mutating" as const` becomes
    `sessionForkOnResume = "clean" as const`.
  - `maxInputCharactersPerTurn` stays at 4000 unless the SDK exposes a
    different per-turn cap.
- Implement `runSideChannelQuery` (mirror the Claude implementation; see
  `apps/server/src/features/providers/adapters/claude/claude-provider.ts` lines 409 to 520 for
  the side-channel and sessionless-fallback pattern, including the
  ETIMEDOUT classification for unresumable sessions and the conversation
  history fallback prompt).
- Implement the same `cwd` parameter routing that Claude's side-channel
  takes. The orchestrator at `apps/server/src/features/handoff/orchestration/handoff-pipeline.ts`
  already passes `cwd` through; Cursor's implementation just needs to consume
  it.

### Files to delete or shrink

- The `runHiddenTurn` method in cursor-provider.ts (about 80 lines).
- The `runRawPrompt` private helper that bypassed UI event emission.
- The 10-second settle-wait poll loop and its constant.
- The disregard turn + acknowledgement turn sequence.
- The `MessageRepo` injection on the Cursor provider, if no other method
  needs it after `runHiddenTurn` is removed (verify by grep).

### Pipeline simplification

After the migration, no provider in mcode declares `"mutating"`, so the
path A branch in `apps/server/src/features/handoff/orchestration/handoff-pipeline.ts`
becomes dead code. Options:

1. Delete the path A branch entirely. The `LadderStep` union becomes
   `"B" | "D"`. Existing handoff artifacts on disk with
   `meta.ladderStep === "A"` need a migration or the type should be left as
   `"B" | "A" | "D"` for backward compat reads.
2. Keep the branch in place but mark it unreachable in production
   (clearer commit history if a future provider does end up using mutating
   resume).

Recommended: option 1 with the `LadderStep` union widened to keep "A"
acceptable on reads from old artifacts. New artifacts only ever get
`"B" | "D"`.

### `IAgentProvider` interface

- `runHiddenTurn?` optional method in `packages/contracts/src/providers/interfaces.ts`
  can be removed if no provider implements it. Verify no other code depends
  on it.

### Schema

- `messages.is_internal` column added in Phase 3.1 was primarily added for
  path A's hidden turns. It can stay (other internal-message use cases may
  emerge), but if the migration removes the only writer of `is_internal: 1`,
  consider whether the column is still earning its keep.

### Tests

- `apps/server/src/features/providers/adapters/cursor/__tests__/` mocks the `cursor-agent`
  subprocess and the JSON-RPC frame parsing. After the migration these tests
  rewrite to mock `@cursor/sdk` directly. Pattern to follow:
  `apps/server/src/features/providers/adapters/claude/__tests__/` already mocks
  `@anthropic-ai/claude-agent-sdk` via `vi.mock`.
- The handoff-pipeline tests that explicitly exercise path A (search
  `runHiddenTurn` in `apps/server/src/features/handoff/orchestration/__tests__/`) will
  fail once the method is removed. Either delete those tests or rewrite to
  exercise path B against a Cursor provider that now supports clean fork.

### Documentation

- `CONTEXT.md` glossary entries for "Path A", "Hidden turn", "Disregard
  turn" should be marked as historical (kept for understanding pre-migration
  artifacts) or removed.
- `docs/guides/chat-fork-handoff.md` updates to reflect the simplified
  ladder.

## Auth and configuration

`cursor-agent acp` uses the locally installed Cursor CLI's auth state
(login persisted on disk by the CLI). `@cursor/sdk` likely uses an API key
or token. Confirm before starting:

- Does `@cursor/sdk` accept the existing CLI auth, or require a separate
  credential?
- Does it work with the same Cursor account tiers (Pro / Business / Free)?
- Per the user's standing preference (recorded in user memory), mcode never
  requires users to set API keys directly. If the SDK requires keys, the
  pattern is to source them from the same place the CLI stores them.

If auth requires a separate path, this becomes a bigger migration than just
swapping the SDK call site. Surface that decision before writing code.

## Existing thread compatibility

User threads currently have `sdk_session_id` values written by the ACP
integration. These IDs almost certainly do not work as `Agent.resume`
arguments against the new SDK. Three approaches:

1. Accept that pre-migration Cursor threads cannot use clean resume. The
   pipeline's sessionless-fallback (Phase 8.2's `runSideChannelQuerySessionless`)
   already handles this gracefully via the conversation-history prompt.
2. Migrate session IDs at startup. Probably impossible since the ACP
   session IDs aren't valid in the SDK's session namespace.
3. Force a session refresh on next user message in any Cursor thread that
   has an ACP-era `sdk_session_id`.

Recommended: option 1. The sessionless fallback is already production
tested.

## Beta caveats

`@cursor/sdk` is in public beta as of 2026-04-29. API may change. Pin the
version in `package.json` and document the version pinned. Watch the
[Cursor SDK announcements forum](https://forum.cursor.com/) for breaking
changes during the migration window.

## What to do first

1. Read `CONTEXT.md` (this repo) end to end. Understand the B/A/D ladder
   and what "path A" is.
2. Read the existing Claude side-channel implementation at
   `apps/server/src/features/providers/adapters/claude/claude-provider.ts` lines 409 to 660
   (the `runSideChannelQuery` and `runSideChannelQuerySessionless` methods
   plus the abort-controller forwarding pattern). The Cursor SDK
   implementation should mirror it.
3. Read the `@cursor/sdk` quickstart at https://cursor.com/blog/typescript-sdk
   and confirm the auth model.
4. Use `superpowers:writing-plans` to draft a migration plan. The plan
   should be small (single subsystem, one provider file, tests, one
   pipeline simplification, docs). Estimate 1 to 3 days of focused work.
5. Use `superpowers:subagent-driven-development` to execute the plan.

## Suggested skills

The next agent should invoke (or have access to):

- `superpowers:writing-plans`. Required to draft the migration plan before
  any code changes. The migration touches multiple files and a capability
  declaration; planning before implementing prevents drift.
- `superpowers:test-driven-development`. Write the new Cursor provider
  tests against the mocked `@cursor/sdk` first, then implement the provider
  to satisfy them.
- `superpowers:subagent-driven-development`. Execute the plan task by task
  with the same fresh-subagent discipline used for the original handoff
  pipeline work.
- `superpowers:systematic-debugging`. Migration of a beta SDK plus a
  provider rewrite has high failure surface. Have the discipline ready.
- `documentation-lookup`. The `@cursor/sdk` docs will be the primary
  reference; cache the relevant pages early.
- `claude-api`. Useful pattern reference. The Claude provider's side-channel
  implementation is the canonical example for what Cursor's should look
  like after the migration.

## Related artifacts

References, not duplicated content:

- PR #499 (commit `fb4e7123`). The merged chat-fork handoff feature whose
  original implementation plan and prototype lived under `docs/plans/`
  pre-merge. The 10-second settle-wait and the rest of the robustness
  guards that this migration would delete live in `cursor-provider.ts`
  and `handoff-pipeline.ts`; read them there instead.
- `CONTEXT.md`. Glossary of all the relevant vocabulary.
- `apps/server/src/features/providers/adapters/claude/claude-provider.ts`. The implementation
  pattern Cursor will follow post-migration.
- `apps/server/src/features/providers/adapters/cursor/cursor-provider.ts`. The current
  implementation. Reads as a JSON-RPC ACP subprocess wrapper plus the
  hidden-turn workaround.
- `apps/server/src/features/handoff/orchestration/handoff-pipeline.ts`. The orchestrator.
  Path A branch around lines 195 to 280. Path B branch above it shows the
  pattern Cursor will use after the migration.
- `packages/contracts/src/providers/interfaces.ts`. The `IAgentProvider`
  interface where `sessionForkOnResume` and `maxInputCharactersPerTurn` are
  declared, and where `runSideChannelQuery` and `runHiddenTurn` are defined.
- External: [Cursor SDK TypeScript blog post](https://cursor.com/blog/typescript-sdk),
  [ACP session/load bug thread](https://forum.cursor.com/t/acp-no-conversation-history-is-restored-when-loading-an-existing-session/158388),
  [Cursor SDK announcements](https://forum.cursor.com/t/cursor-sdk-cloud-agents-api-updates/159284).

## Things that are NOT this migration

To avoid scope creep, the following are explicitly out of scope and should
remain deferred:

- The same-thread cross-provider switch feature (still deferred per the
  original plan).
- The "live regenerate handoff" RPC endpoint (currently a stub returning
  `not-implemented`).
- The content-addressable blob store for attachments (v2 optimization).
- Codex / Copilot side-channel implementations (separate migrations, may or
  may not unlock path B for those providers).

## Done criteria

This migration is complete when:

1. `apps/server/src/features/providers/adapters/cursor/cursor-provider.ts` no longer spawns
   `cursor-agent` as a subprocess.
2. Cursor's `sessionForkOnResume` is declared `"clean"`.
3. `runSideChannelQuery` is implemented on Cursor with both the clean-resume
   and sessionless-fallback variants.
4. `runHiddenTurn` is removed from the Cursor provider, the
   `IAgentProvider` interface (if no provider implements it), and the path A
   branch in the orchestrator.
5. Existing Cursor provider tests are rewritten against the mocked
   `@cursor/sdk`.
6. A new test verifies that path B fires for Cursor (and that path A is
   never reached).
7. Focused tests and typecheck pass.
8. `CONTEXT.md` and `docs/guides/chat-fork-handoff.md` reflect the simplified
   ladder.

## A note on why this isn't in the OS temp directory

The `/handoff` skill normally writes to `os.tmpdir()` because session
handoffs are ephemeral, expected to be consumed once by a fresh agent and
discarded. This handoff is different: it is a project handoff describing a
deferred migration that may be picked up days, weeks, or months from now,
by a different developer than the one who created it. Lives in the repo on
purpose. The skill's "save to OS temp" instruction was deliberately
overridden by the user when invoking it.
