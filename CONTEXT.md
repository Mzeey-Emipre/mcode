# Context: Mcode Glossary

Domain terms used across this repo, resolved during design conversations.
This file is a glossary only. No implementation details, no architecture, no
specs. For those see `ARCHITECTURE.md`, `docs/plans/`, and
`docs/guides/`.

## Providers

### Provider
An external AI agent backend that a thread runs against. Each provider is a
separately-installed CLI on the user's machine (Claude, Cursor, Codex,
OpenCode, GitHub Copilot). Mcode adapts to each one via an `IAgentProvider`
implementation. Providers are user-scoped (installed per user), not
workspace-scoped.

### Default provider
The provider used for new threads when the user does not pick one
explicitly. Set globally in user settings.

### Utility provider
The provider used for short, one-shot, non-conversational completions that
the app issues on the user's behalf (currently: drafting PR titles/bodies
and summarising a diff). Set globally in user settings; may differ from the
default provider. Handoff generation is **not** a utility-provider use case;
handoffs route through the originating thread's own provider via the B/D
pipeline.

### Session runtime
The per-Provider service that owns the uniform persistent-CLI-session
lifecycle: the session pool, the lazy idle-eviction timer (60s sweep, 10min
default TTL) with a `lastUsedAt + isBusy` guard, Windows `JobObject`
attachment, the env snapshot, lazy spawn, resume-then-fallback, and the
graceful-interrupt-then-hard-kill (`taskkill /T /F` on Windows) close. It
treats per-session state as opaque (`SessionRuntime<TState>`) so the same
lifecycle serves every Provider. Each Provider holds its own instance; the
runtime is not shared, keeping per-session state type-isolated.

### Provider reattachment
Restoring observation and control of the same still-running Provider thread
and turn after transport loss, without creating a new turn.

### Same-turn recovery
Provider-native continuation of an existing turn with the same turn identity
and preserved execution history, without a new user message.

### Replacement turn
A new turn linked to an interrupted turn when same-turn recovery is
unavailable. It is explicitly initiated and may repeat effects from the
interrupted turn.

### Protocol adapter
The per-Provider seam carrying the protocol-specific I/O the Session runtime
delegates to: `spawn` (returning the session state plus any child PIDs the
runtime should attach/kill), `isBusy` (the eviction guard), `interrupt`
(protocol-level graceful stop), `close` (provider teardown short of the OS
kill), and `isStale` (whether a pooled session must be discarded before
reuse). Each Provider *is* its own Protocol adapter (the Provider class
implements the interface); composition with the Session runtime, not
inheritance.

### Provider runtime event
A provider-to-server event that can include provider-native evidence needed for
server-side interpretation. It is not a renderer event.

### Agent event
A provider-neutral event used by the server and renderer to represent a turn's
visible progress, such as text, tools, lifecycle, and errors. It excludes
provider-native identity and private child evidence.

## Workspaces and worktrees

### Platform command
A Project environment command used by Setup or a Project action. It can define
a default script and operating-system overrides. Mcode resolves one script for
the current system and runs it from the active Thread's checkout root with the
Project's configured terminal and its normal environment.

### Workspace
The top-level container that owns a set of threads. Anchored 1:1 to a local
repository or folder path; a workspace cannot exist without one. The
workspace is the main folder the user set up first. Worktrees rooted under
that folder may host their own threads, but those threads still belong to
the parent workspace.

Workspace-level settings do not exist yet. All user-facing settings (default
provider, utility provider, etc.) are global (user-level) today. Providers
are installed on the user's machine, not on the workspace.

**Project** is the user-facing name for a Workspace. Every UI string ("Add
project", "Recent Projects", "No projects yet") says _project_; the code and
this glossary say _Workspace_. They are the same thing.
_Avoid_: using "project" in code or schema; reserve it for user-facing copy.

### Worktree
A git worktree provisioned under a workspace so a thread can run against
an isolated checkout of the repo. Standard git semantics, one repository
with multiple working directories, applied as an isolation primitive: each
worktree-mode thread runs against its own files and, in dev mode, its own
database. A worktree-mode thread may start without its own branch; the user
can create that branch later from the Overview.

**A worktree is not 1:1 with a thread.** Multiple threads can share the
same worktree via the composer's "Existing worktree" mode. A thread can
also run *without* a worktree, directly against the workspace's main
checkout. See "Direct mode" below.

Mcode removes a worktree in its sandbox when cleanup starts only if no active
thread links to it. It then removes every linked thread that is not active.
If an active thread links to the worktree, Mcode keeps both. It removes only the
selected completed thread. Mcode keeps a checkout outside its
sandbox or on the repository default branch, then removes only the selected
thread data. When a user deletes a thread manually, they can choose whether
to schedule worktree cleanup.

### Branchless worktree
A worktree that has no named branch yet. It starts from a selected base
branch and lets the thread run in isolation before the user decides whether
the work needs a branch. In branch-facing UI, the current ref is shown as
`HEAD` with a short commit hash rather than as the selected base branch.
In Review comparisons, the target is shown as `HEAD` and the base remains
the selected base branch for that worktree.
_Avoid_: Headless worktree

### Thread checkout state
The thread's current git position. A worktree thread is either on a named
branch or in a branchless worktree with a base branch and current `HEAD`;
callers must not infer this state from the branch label alone.
_Avoid_: Treating `HEAD` as a branch name

### PR-able thread
A thread the app can open a pull request from. A thread is PR-able only
when it runs in an isolated worktree on a named branch; direct-mode and
branchless worktree threads are not PR-able yet. This single notion gates
background PR and commits-ahead polling. A branchless thread can still use
the Create PR entry point, but that flow must ask for a branch name and
create the branch before opening the pull request.

## Composer

### Composer mode
The mode the composer is in when the user creates a new thread, determining
whether the thread runs against the workspace's main checkout or against a
worktree, and whether that worktree is new or pre-existing. Three modes:
**Direct**, **New worktree**, **Existing worktree**. Once a thread has been
created, its mode is fixed for the life of the thread. The composer shows
the chosen mode in read-only form rather than as a fourth mode.

### Direct mode
Composer mode where the thread runs against the workspace's main checkout.
No isolation: file edits affect the user's primary working directory and
current branch. The default when a workspace is not a git repo.

### New worktree mode
Composer mode where the thread provisions a fresh git worktree from a
selected base branch without requiring the user to name a new branch first.
Used when the user wants isolation before deciding whether the work needs a
branch. Code identifier: `"worktree"`.

### Existing worktree mode
Composer mode where the thread attaches to a worktree that already exists.
Enables multiple threads to share one worktree, such as follow-up work on
the same branch without re-creating the directory. Existing worktree mode can
also attach to a branchless worktree.

### Composer session
The composer's per-thread state, treated as one value: draft text,
attachments, model, provider, reasoning level, composer mode,
access/permission mode, context window, orchestration mode, and provider-specific toggles. Owned
by one module whose interface is **snapshot** (save the outgoing thread's
session) and **restore** (install the incoming thread's session as a single
state transition). Switching threads is one restore; the editor update is an
implementation detail behind the seam. (Epic #649, slice #655.)

## Interaction modes and composer capabilities

Build and Plan remain mutually exclusive provider behaviors. The composer
presents Build as the default and Plan as an attachable capability. Users add
Plan from the plus menu or `/plan`; its chip can be removed before sending.

### Plan mode
A thread state where the agent produces a structured plan instead of
executing changes. The agent reasons, searches the codebase, drafts a plan
document, and presents it for the user to approve, revise, or reject.
Distinct from the Plan tab, which is a right-panel surface for viewing saved
plan documents.

### Build mode
The implicit default where the agent performs the work: editing files,
running tools, and making changes. Build does not occupy a composer chip.

### Goal capability
A removable composer capability for installing an objective immediately
before the next turn. Users attach it from the plus menu or `/goal`. An active
provider goal remains visible as a compact chip with its lifecycle details.

> **Codebase mismatch (rename pending).** The `AgentDefaultModeSchema`
> still exposes a deprecated third `"agent"` value that should be dropped;
> the product has only Plan and Build.

## Model configuration

Per-thread settings that configure *how* the agent runs the model. None of
these are "modes" in the interaction-mode sense — they're configuration
axes that compose with whatever interaction mode is active.

### Permission mode
A thread-level setting controlling how much the agent can do without
explicit user confirmation. Two values: **Supervised** (prompts the user
before risky operations like edits and shell execution) and **Full** (the
agent acts without prompting). Default for new threads: **Full**.

### Context window
A per-thread selection of the model's context window size, sent to the
provider as a model slug suffix. Today only Claude exposes multiple tiers
(`200k` and `1m`); other providers ignore the setting. The 1M tier
unlocks Claude's extended context but typically costs more per turn.

### Reasoning level
A per-thread setting that controls how much reasoning effort the model
spends per turn. Values: `none`, `minimal`, `low`, `medium`, `high`,
`max`, `xhigh`. Each provider maps the value to whatever its
SDK supports. Claude uses these directly (with `max` mapping to extended
thinking on supported models), Codex maps `none`/`minimal` to its own
presets, and Copilot honours the level per model capability. The Cursor
provider does not expose a reasoning-level selector; its models manage
reasoning internally.

### Orchestration mode
A per-thread setting with `standard` and `proactive` values. The composer
exposes proactive orchestration as a removable provider-specific capability:
**Ultra** for supported Codex models and **Ultracode** for supported Claude
models. Ultra maps to the Codex app-server's native `ultra` effort. Ultracode
enables Claude's session-scoped dynamic workflow orchestration. Neither value
is a reasoning tier.

## Chat threading

### Thread
A single chat conversation between a user and an AI agent. Threads belong to
workspaces and run against a provider. Distinct from a git branch even though
threads can be associated with a worktree.

### Thread conversation residency
The renderer's single client authority for a selected Thread's conversation.
It activates and revalidates the selected transcript, retains inactive
transcripts within a bounded cache, routes pagination and prefetch work, and
routes refresh work. `threadStore` projects validated AgentEvents into resident
Thread records. Server messages and narrative metadata remain durable data;
live Turn state remains client memory.

### Fork (verb), forked thread (noun)
The act of branching a conversation from a specific message in a parent
thread, creating a new child thread that picks up from that anchor point.
Renamed from "branch" in UI copy to disambiguate from git branches. The
schema field is already named `forked_from_message_id`.

### Parent thread / child thread
The pre-existing thread a fork is created from is the **parent**. The newly
created thread is the **child**. The parent is unaffected by the fork; the
child inherits the parent's context via a handoff.

### Fork anchor
The specific message in the parent thread that a fork is created from. Has a
**role**, either `user` (forking from your own message; intent is "retry")
or `assistant` (forking from the agent's reply; intent is "follow up about
what was just said"). The role shapes how the handoff is framed.

### Create branch
An [[Overview]] action that runs `git checkout -b <name>` in the active thread's
own working directory: it creates a branch at the current HEAD and switches the
thread onto it. **Same thread, same worktree, new branch** - no child thread, no
handoff; the thread's `branch` updates in place. Backed by a net-new
`git.createBranch` RPC (create + checkout); the app otherwise only checks out
*existing* branches.

Not to be confused with [[Fork]]. The two share one git primitive (a branch
pointer) in exactly one case, which is why they are easy to collapse, but they
are different actions: Create branch moves *this* thread onto a new branch right
here, whereas Fork spawns a *new* thread - and only its new-worktree variant
also creates a separate worktree; existing-worktree reuses that worktree's
branch, and new-local does no branch op at all. One line each:
Create branch = "this thread, new branch, here"; Fork = "a new thread, possibly
elsewhere."

## Chat lifecycle

### Setup gate
The Thread-owned decision that controls whether the first Turn can start while
automatic Setup is required. A Setup pass or **Continue without setup** releases
the gate permanently for that Thread. Manual Setup does not close a released
gate.
_Avoid_: Setup status

### Setup attempt
One execution of a Project environment's Setup command for a Thread. A Thread
can have many Setup attempts, and each attempt keeps its own result. The Setup
gate and Setup attempts are separate concepts: an attempt records what happened,
while the gate records whether the first Turn can start.
_Avoid_: Setup gate, Setup run status

### Turn
One round of agent execution within a thread, bounded by a `TurnStarted`
event and a `TurnCompleted` event. A turn may be triggered by a user, provider,
or child and records its trigger provenance; provider- and child-triggered
turns do not require a user message. The agent then does whatever work it
needs (streaming thoughts, calling tools, reading files, dispatching
sub-agents) before producing its final response. Everything from the trigger
to the final agent response is the **same turn**, no matter how many
intermediate steps occurred. Costs, token counts, and tool-call sequences are
attributed per-turn, and several pieces of client-side state are scoped to the
current turn.

### Turn attempt
One provider dispatch within a Turn. A transient retry starts another attempt
but keeps the same Turn identity.
_Avoid_: Retry turn

### Tool call
A single tool invocation the agent makes during a turn (e.g. `Read`,
`Bash`, `Grep`, `Edit`). Each tool call has an input, a result, and a
completion status, and renders as one row in the narrative timeline.
Multiple tool calls can run in parallel within the same turn. All
user-visible tool calls are domain tool calls; internal SDK plumbing is
not.

### Sub-agent thread
A provider-native child conversation created from the current turn and
persisted as a normal Mcode thread. Sub-agent threads may run in parallel and
may themselves dispatch further sub-agents (nested). A sub-agent thread is
distinct from a [[Delegated thread]] created through [[Thread control]].

### Sub-agent call
The parent-turn tool or action that creates or contacts a [[Sub-agent thread]].
It remains part of the parent Turn. Each sub-agent call's events are attributed
to its parent via `parentToolCallId` so the narrative timeline can nest them
correctly. The phrase “use a sub-agent” means this provider-native behavior;
it never authorizes [[Thread control]].

Provider-native identity evidence links a sub-agent thread to its sub-agent
call. A name or a heuristic alone does not establish that relationship.

Sub-agent calls are **always shown** in the user's timeline; the user
should be able to tell when the agent has handed work to a sub-agent. From
the user's point of view, a sub-agent call is still part of the same turn as
the parent.

A sub-agent call counts as **running until its work finishes**, regardless of
how the provider signals dispatch. Some providers (Codex `spawnAgent`)
report the dispatch call itself as complete the moment the child is created;
the timeline must not show the sub-agent as done until the child actually
reports back. The sub-agent thread's own narration is not streamed into the
parent timeline; child detail separately shows its full timeline.

### Coordinator thread
A thread that assigns work to one or more delegated threads and monitors their
progress.
_Avoid_: Parent agent, orchestrator session

### Delegated thread
A normal Mcode thread created by a coordinator thread to perform an explicit
assignment. It remains visible and controllable as its own thread.
_Avoid_: Sub-agent thread, hidden child session

### Thread delegation
The durable assignment and relationship between a coordinator thread and a
delegated thread. It records which Thread and Turn created the assignment but
does not make the delegated thread part of the coordinator's Turn. The
delegated thread has its own lifecycle and survives the coordinator stopping or
disconnecting.
_Avoid_: Sub-agent call, conversation fork

### Thread control
The capability to discover Projects and Threads, create a delegated thread,
read it, send it work, stop it, or wait for its state. Thread control always
excludes the active source thread so a Thread cannot target itself.
_Avoid_: Sub-agent control, conversation-fork control

### Internal thread control
Thread control exercised by a Provider running inside an authenticated Mcode
Thread. It acts for the current user across registered Projects.
_Avoid_: Provider subagent API

### Paired external thread control
Thread control exercised by an external integration paired with Mcode. It is
limited to selected Projects, granted operations, and ownership rules.
_Avoid_: Internal thread control, unrestricted MCP access

### Message origin
The durable source of an inbound user-role Message. A Message comes from the
composer, another Thread, or a legacy row created before origin was recorded.
A Thread origin identifies the source Thread, Turn, and Provider. It does not
label the sender as human or agent.
_Avoid_: Message author type

### Text delta
A streaming text chunk emitted by the provider as the agent types its
output. Many text deltas accumulate during a turn. At emission time the
deltas are unclassified — the system does not yet know whether they will
become part of the final response or get grouped as preamble narration.
Classification is resolved later by the `AssistantMessageBoundary` signal.

### Reasoning block
Structured reasoning output emitted by the provider when extended thinking
is enabled (e.g. Claude's `thinking` content blocks). A reasoning block is
its own distinct response object in the SDK — **not** the same as a stream
of text deltas. Mcode does not yet surface reasoning blocks; they will
become visible when extended thinking is wired into the UI.

### Narration segment
A contiguous group of text deltas the agent emitted **before** a tool call
within a turn — the agent's narration of what it is about to do. Distinct
from the final response (text deltas emitted *after* all tool calls have
resolved) and distinct from a reasoning block (only emitted when extended
thinking is on). Classification happens at the `AssistantMessageBoundary`
event: a `stop_reason` of `tool_use` closes the buffered deltas as a
narration segment; `end_turn` / `stop_sequence` / `max_tokens` / `refusal`
reclassifies them as final-response text instead.

Providers without a stop-reason concept (Codex) classify by **retroactive
promotion**: every assistant message streams as narration while the turn
runs, and the last one is promoted to final response when the turn ends.
The boundary signal is the same either way; only the moment of certainty
differs.

> **Codebase mismatch (rename pending).** The code currently calls this
> concept `ThoughtSegment` (table: `thought_segments`). That name is
> misleading — these are not SDK "thoughts." A follow-up rename to
> `NarrationSegment` is planned.

### Final response
The text the agent produces after all tool calls in a turn have resolved,
intended as the user-facing reply for that turn. Identified by the SDK's
terminal `stop_reason` (`end_turn`, `stop_sequence`, `max_tokens`,
`refusal`) and persisted as the assistant message's `content`. Distinct
from narration segments (which are persisted to a separate table) and from
reasoning blocks (not yet surfaced).

### Streaming checkpoint
A server-owned durable record of user-visible output accepted during an
unfinished turn. Distinct from a finalized Message, which represents the
completed conversation record.

### Message
A persisted unit of conversation in a thread. Each message has a **role**
(`user`, `assistant`, or `system`), a sequence number, and an optional
`is_internal` flag that excludes it from user-visible queries. User and
assistant messages drive the normal turn flow. System-role messages anchor
synthetic context — today used for the handoff document at sequence 1 in
a child thread and for the "Context compacted" marker placed after
compaction runs. Messages are what `forked_from_message_id` points to and
what hidden messages exclude themselves from in user-visible queries.

### Conversation page
The unit a thread's visible conversation loads in: one pagination window of
messages together with their narrative (tool calls, narration segments, hook
executions), served by a single request whose cost is a fixed number of
queries regardless of how many turns the page spans. Loading a thread means
loading its latest conversation page; paging back loads older pages through
the same interface. (Epic #649, slices #650/#651.)

### Streaming vs settled rendering
Two adapters at one rendering seam for agent text. While text deltas are
arriving, a block renders through the **streaming adapter** (plain
pre-wrapped text with the typing cursor — cheap per frame). Once the block
settles (its deltas stop, classification resolved), it renders through the
**settled adapter** — full markdown with code highlighting, parsed once. The
user sees the same final result; only the cost during streaming differs.
(Epic #649, slice #658.)

### Turn outcome
How a turn ended, as one of four mutually-exclusive states:
**completed** (the agent finished its work normally), **cancelled** (the user
explicitly stopped the turn), **interrupted** (infrastructure or a process
disappeared before a terminal outcome), or **errored** (a known terminal
provider or turn failure).

> **Codebase mismatch.** Canonical persistence currently stores
> `Completed|Interrupted|Errored`, so it lacks the distinct `Cancelled`
> outcome.

### Recovery incident
The exact set of active turns that one backend restart interrupted. The server
creates the incident at startup and records each affected turn with that
identity. It may include threads from every workspace, but excludes threads
the user completed. The incident remains stable for that server run. A client
may dismiss it for its current app session.
_Avoid_: Interrupted-turn history, recovery error list

### Terminal proof
Authoritative provider or system evidence that confirms one [[Turn outcome]].
A final-looking assistant response is not terminal proof.
_Avoid_: Final response

### Empty turn (recordable activity)
A turn that produced nothing worth keeping: no tool call, no assistant body,
no narration segment, and no hook. **Recordable activity** is the named
predicate for the inverse — a turn has recordable activity when any one of
those contributors is present. A turn with no recordable activity should
leave no assistant row, so the thread is not cluttered with hollow entries.

> **Behaviour pending.** Today a turn that produces nothing recordable can
> still write a hollow assistant row, because the row is committed on a
> separate event before anything decides the turn was empty.

### Transient failure (auto-retry)
A turn failure that a second attempt would plausibly clear — a stale pooled
session, a subprocess spawn race, a brief network blip — as distinct from a
fatal failure that will recur. A transient failure prioritizes provider-native
same-turn recovery, with a replacement turn only as an explicit fallback when
same-turn recovery is unavailable. Which signatures count as transient is a
small explicit allowlist, not a heuristic.

> **Behaviour pending.** Today every turn failure is treated as terminal and
> costs a manual re-send, transient or not.

## Handoff

### Handoff
A markdown document summarizing the parent thread so a forked child picks up
with the parent's context, replacing a verbose transcript replay. Delivered
**off-band by default**: the full document is written to a stable OS temp path,
and the child's first-Turn inline prompt carries only a small payload (a pointer
to that file, a 2-3 sentence graceful-degradation summary, and the child's first
user message). The child Reads the full document on its first Turn under a
one-shot Scoped pre-grant, so Handoff quality is no longer capped by the child
Provider's per-Turn input budget. The full document is retained at the temp path
until garbage collection so the user can inspect it later.

### Scoped pre-grant
A pipeline-issued permission bypass authorising the child to `Read` exactly one
file (its Handoff document) on exactly one Turn (its first), consumed once. It
is **path-scoped** (only that file), **Turn-scoped** (does not survive into the
second Turn), and **one-shot** (a second Read of the same path on the same Turn
is not pre-granted). It bypasses the Thread's `permissionMode` only for that
single Read. A pipeline guarantee that makes the Handoff feel invisible — not a
user-configurable Hook.

### Handoff pipeline
The orchestration layer that produces a handoff for a given fork. Routes
through one of two paths (B / D) based on the parent provider's capability
and live availability.

### Side-channel
A provider call made out-of-band from the user-visible conversation, used to
generate a handoff. Does not appear in the parent thread's UI. Side-channels
typically use a separate SDK process.

## The B/D ladder

### Path B (clean side-channel)
Resumes the parent provider's session in a forked SDK process to generate
the handoff. The original session is untouched. Used when the provider
declares `sessionForkOnResume: "clean"` (Claude, Cursor, Codex, Copilot).

### Path B-prime (sessionless side-channel)
Variant of path B that runs without `resume:` when the parent's session
isn't available (e.g. after a server restart). Provides the conversation
history as text in the prompt instead. Same artifact ladder step ("B") from
the caller's perspective.

### Path D (deterministic)
Local builder that produces the handoff from message rows without invoking
any provider. Used as the universal fallback. Lowest fidelity but always
available.

### Ladder step
A label on a produced handoff artifact (`"B" | "D"`) identifying which path
generated it. Stored in `handoff.json` for diagnostics and the fallback
banner copy.

## Handoff delivery

Handoffs are delivered **off-band by default**: the full document lives at a
stable OS temp path and the child Reads it on its first Turn under a one-shot
Scoped pre-grant (see the `Handoff` and `Scoped pre-grant` terms above). Because
the document body never has to fit inside the child's per-Turn input window, the
legacy sizing concepts are retired:

- **Full / Minimal mode** — removed. There is no per-budget mode switch; the
  document is always the complete handoff. (`HandoffMeta.mode` is retained as the
  constant `"full"` for back-compat with older `handoff.json` provenance.)
- **Character budget** — removed as a handoff doc-body sizing driver. The inline
  first-Turn payload (pointer + short summary + user message) is small by
  construction.
- **Overflow** — removed. The off-band temp file *is* the document, not a spill
  of whatever exceeded an inline budget.

`maxInputCharactersPerTurn` remains declared per Provider but is **decorative**
for Handoff purposes after this change.

## Provider capabilities

### Session fork behavior
Declared per provider as `"clean" | "unsupported"`. **Metadata only** since
each Provider now carries a `forker: SessionForker` that the pipeline
dispatches through (`provider.forker.fork(req)`); this label is used for
`handoff.json` provenance and the fallback banner copy, and historically
mapped to ladder paths as:

- **clean**: `resume:` spawns a fork without mutating the original (Claude,
  Cursor, Codex, Copilot)
- **unsupported**: provider can't fork sessions; pipeline goes directly to
  path D

### Per-turn input cap
The maximum input characters a provider accepts per turn. Declared as
`maxInputCharactersPerTurn`. Decorative for Handoff purposes since Handoff
delivery went off-band (see `Handoff delivery`); retained as Provider metadata.

### Goal support
The ability to set, inspect, and clear a standing **goal**: a thread-scoped
completion condition exposed through `/goal`. A goal belongs to the thread's
provider runtime rather than a single chat message. Mcode may render
transcript receipts for goal events, but the active goal state is provider
metadata.

Goal support is a **capability a provider has**, not a provider it is: a
provider either implements Mcode's goal capability, exposes a native goal API
that Mcode can bridge, or lacks goal support. On a provider that lacks it,
`/goal` passes through to the model as plain text so the model still sees what
the user typed.

## Server runtime

### Thread-scoped push
The routing rule for server-pushed events: a client declares which threads
it is watching, and an event carrying a thread id is delivered only to
clients subscribed to that thread. Events without a thread id remain
broadcast to every client. A window's bounded watch set contains its selected
thread and any threads with running agents, which keeps their live layers warm
during a switch. Unrelated idle threads remain excluded. Payload validation at
this seam has two adapters: validating (dev, logs schema drift) and pass-through
(production). (Epic #649, slices #656/#657.)

### Grace period
The countdown between the last client session disconnecting and the server
shutting itself down. It only starts when the server is not busy; a busy
server never begins the countdown, no matter how long clients stay away.
A new session connecting cancels it. Distinct from session-runtime idle
eviction (which retires pooled provider CLI sessions, not the server).

### Busy (server)
The server is busy while any agent turn is in flight or any integrated
terminal is running. Busy suppresses the grace period and is the condition
under which the desktop app holds a power-save blocker so the machine does
not suspend mid-work. Connected-but-idle clients do not make the server
busy.

### Git executor
The single module that owns running git as a child process on the server:
asynchronous execution, queueing per repository, timeouts, and caching of
repeated repository-discovery results. Every git caller — file watching,
workspace enrichment, worktree cleanup, branch listing — goes through it,
so a slow git command never blocks the event loop. In tests, a fake executor
adapter stands in for real process spawns. (Epic #649, slice #659.)

### Snapshot dirtiness gate
The short-circuit inside turn-snapshot capture: when the working tree is
clean, the snapshot ref resolves from HEAD with one cheap status check
instead of staging the whole tree; when dirty, capture behaves as before.
Turn views and the Cumulative comparison are unaffected — only the cost of
capturing on a clean tree changes. (Epic #649, slice #660.)

## Internal / hidden state

### Internal message
A message persisted with `is_internal: 1`. Excluded from the user-visible
timeline and from queries by default. Used for the synthetic system message
anchoring a handoff at sequence 1 in a child thread.

### Provenance metadata
The `handoff.json` sidecar accompanying every `handoff.md`. Records which
path produced the doc, when, against which provider, with which classified
error (if any). Used by the View doc dialog and by the fallback banner copy.

## Related but distinct

### Cross-provider switch
Swapping a thread's provider mid-conversation. The **same thread continues**:
its id, message history, and worktree are unchanged; only the active provider
swaps. The outgoing provider generates a handoff (B/D ladder, anchored at the
thread's last message), and the incoming provider reads that doc to pick up
context. The thread's persisted messages stay intact; only the new provider's
in-memory context comes from the handoff.

Swap-back (A → B → A) is the same process repeated: each direction is one
handoff. The outgoing session is abandoned and eventually evicted by the
session runtime's idle timer; swap-back spawns a fresh session on the
returning provider with a new handoff, not a resumed session.

Surfaced in the [[Overview]] as the **Switch provider** action, kept distinct
from the Overview's Fork actions (which spawn a new thread). Was a deferred item
in the chat-fork handoff feature (PR #499); un-deferred for the Overview epic.

### Compaction
A separate mechanism that summarizes a thread's older turns into a single
compact summary stored on the thread itself, used to keep long threads
within their own provider's context window. Distinct from a fork handoff,
though the orchestrator does consult `last_compact_summary` when building a
deterministic path-D handoff.

## Pull request review

### Pull request inbox
The workspace-level surface that gathers pull requests the user authored or was
asked to review across connected repositories. It is independent of the active
thread and groups review work by the user's relationship to each pull request.
The All relationship view presents Review requested, Previously reviewed, and
Authored as one ordered set of subsections. Fresh loaded rows are reused across
covered relationship views and local search or filters refine that snapshot
without replacing the inbox with a loading state.
_Avoid_: PR tab, Review tab

### Pull request review
The read-and-respond workflow for one remote pull request: inspect its summary,
conversation, checks, and code changes, then optionally submit a review. It does
not require a local thread or worktree.
_Avoid_: Checkout

### Remote effect
The named GitHub change a Pull request mutation would make: post an issue
comment, submit a review, change readiness, close, or merge. The interface shows
the Remote effect before confirmation. Pull request mutation names the confirmed
attempt; Remote effect names what that attempt changes.
_Avoid_: Action, when it hides what would change

### Review draft
A session-local inline comment, thread reply, or overall review body tied to one
base and head snapshot. A Review draft does not exist on GitHub until the user
confirms Submit review. It becomes outdated, rather than moving silently, when
the Change stack changes. A failed, conflicted, or rate-limited submission keeps
the draft available for correction or retry.
_Avoid_: Pending review, which is a provider-side object used only during submission

### Change stack
The complete set of changes proposed by a pull request, viewed as one reviewable
unit across its summary, timeline, checks, comments, commits, and file diffs.
_Avoid_: Diff, when referring to the whole pull request

### Review worktree
An isolated local worktree created from a pull request's head branch so the user
can ask an agent to inspect or modify the proposed changes. It belongs to a new
thread and does not alter the source pull request until the user explicitly
commits, pushes, comments, reviews, or merges.
_Avoid_: Checkout, pull into a worktree

### Review task
The thread created to work on a pull request's Review worktree. It carries the
pull request as its starting context and follows the normal thread lifecycle
after creation.
_Avoid_: Pull request thread

### Review Change Stack
The local continuation action that creates or reuses a Review worktree and
Review task for a pull request. It may fetch refs and update local Git and Mcode
state, but it never posts, reviews, closes, merges, commits, or pushes.
_Avoid_: Checkout, Submit review

### Pull request mutation
An explicit remote write against one pull request: post a comment, submit a
review, change draft or ready state, close, or merge. Each mutation names its
effect before confirmation and rechecks current GitHub state before writing.
Reading, refreshing, and Review task creation are not mutations.
_Avoid_: Action, when the remote effect is the important distinction

### Mutation outcome unknown
A pull request mutation result used when GitHub may have accepted a write but
the response did not establish the outcome. The user must refresh remote state
before choosing another effect. Retrying the same attempt keeps its identity.
_Avoid_: Failed, which states that the write did not happen

## Thread overview

### Overview
The chat-header popover that recaps the active thread's working context (its
changes, current branch, and pull-request state) and hosts the git actions for
that thread (Commit-or-push, Create PR). An enrichment of the former plain
header menu (`header-workspace-menu`) into a live status surface, modelled on
Codex's "Environment" panel. Code symbol: `ThreadOverview`.

**Thread-scoped.** The Overview lives in the chat header, which renders only
when a thread is active. With no thread open there is no Overview; the
workspace-root view of changes and branches stays the Review tab's job.

The Overview offers two ways to take the thread further, split by what each does
to *this* thread. Both anchor at the thread tail (not a picked message):

When a thread has a saved plan, the Overview includes a Plans section with
the latest non-superseded plan title. The title is a one-line link into the
Plan tab; older versions stay in the Plan tab.

For branchless worktrees, the Overview shows the checkout as `HEAD` from the
selected base branch and makes Create branch the next git action. After Create
branch succeeds, the Overview shows the named branch like any other worktree
thread.

**[[Fork]]** - spawns a *new* child thread; this thread stays untouched. Three
targets:

- **New worktree** - child thread in New-worktree mode + handoff.
- **Existing worktree** - child thread in Existing-worktree mode + handoff.
- **New local thread** - child thread in Direct mode + handoff.

**Switch provider** - a [[cross-provider switch]]: *this same thread* continues
(id, history, worktree unchanged) and only the provider driving it swaps, with a
handoff generated from the outgoing provider. Swap-back is the same process.

Handoff is always-on for both - it is the mechanism, not a standalone menu item.
The split keeps "spawn a copy" (Fork) visually distinct from "change this
thread's driver" (Switch provider); the two can re-merge into one list later if
the distinction does not earn its place.

_Avoid_: calling this surface "Summary." [[Summary]] is the AI prose lens of
the Cumulative diff (a diff-to-prose toggle inside the Review tab), a different
surface. The Overview is a status-and-actions menu, not a diff lens.

### Recap
A short AI-generated one-line "what you're working on" for the active thread,
shown at the top of the [[Overview]]. Produced by a stateless server RPC (our
utility model) and cached **in memory per thread, never persisted** (resets on
restart). Generation is deliberately frugal: user-triggered from the row, or
automatic only when the user re-orients to a stale thread. Re-orientation means
returning to the app, switching back to a thread, or opening the Overview. A
thread is stale for Recap when its last completed turn is old enough (default:
about five minutes), the conversation signature changed, and no turn is
running. See ADR-0013.

_Avoid_: confusing the Recap with [[Summary]] or [[Overview]]. [[Summary]]
summarizes the **code diff** (a Review-tab lens); the Recap summarizes
**conversational intent**. [[Overview]] is the **surface** that hosts the Recap,
not the recap text itself.

### Re-orientation
The moment a user returns to a thread and needs to remember what it is about.
In Mcode this is broader than terminal focus: it includes the app regaining
focus, the user switching back to a thread, and opening the thread's
[[Overview]]. Recap auto-generation keys off re-orientation rather than a timer
that runs while the user is already watching the thread.

## Right panel

### Right panel
The workspace-level surface docked to the right of the chat, hosting a set
of typed tabs (Browser, Terminal, Review, Plan, and later Files). The
panel itself, its visibility, width, and active tab, is **workspace-global**
and persists with no thread open. Each tab type sets its own availability:
some (Browser, Terminal) run against the **workspace root** when no thread
exists; others (Plan) require a thread. This replaces the former model
where the entire panel was thread-scoped and could not render without a
thread. (Per-tab *content* scope — e.g. whether a thread keeps its own
Browser tabs — is defined on each tab type below, not here.)

### Tab availability
The rule set governing which tab types a user can create at a given moment.
Browser, Review, Plan, and Files are **singletons** at the top level.
Terminal is repeatable: each open Terminal tab represents one **shell
session**. The set of **creatable** types is filtered by **scope** (types
needing a thread are dropped when no thread is active) and by
**cardinality** (open singleton types are dropped, while Terminal remains
creatable until its limit of four shell sessions per terminal scope is
reached). When exactly one type is creatable, the add affordance opens it
directly instead of showing a menu; when none are, the add affordance is
hidden. The empty panel and the add menu present this same creatable-types
set. Tabs share one creation-ordered sequence regardless of type. A newly
created tab appends to that sequence. The user can reorder any tab by pointer
drag or keyboard movement without changing its content or the panel's size.
Each thread preserves its own tab order. The workspace-level panel used with
no active thread preserves a separate order.

### Plan tab
The right-panel tab that shows a thread's saved plan documents. It is
thread-only and contains the plan artifact itself, not the agent's live task
list.
_Avoid_: Scope tab

### Plan preview
The composer-adjacent preview shown after a plan is generated for the active
thread. It shows only the plan title, ellipsized to one line, plus View plan
and dismiss actions; opening the Plan tab or dismissing the preview closes it.
It is transient and separate from the saved plan document. Dismissal applies
to the visible plan version only; a newer generated plan version shows a fresh
preview. Preview dismissal is session-local UI state; it is not persisted. The
plan preview appears only from a live generated-plan event; saved plans loaded
during app startup do not create previews. The plan preview replaces transcript
plan artifact cards; generated plans stay out of assistant messages.

### Task bubble
The composer-adjacent surface that shows the agent's current task list for
the active thread. Collapsed, it shows one aggregate status circle and a
settled-over-total count; clicking it expands the list upward above the
composer. Its status circle is derived from parent-agent tasks: active when
any task is in progress, completed when every task is completed or cancelled,
pending when no task has started, and mixed when settled and pending tasks
coexist. It clears as soon as the user sends a new turn if every task is
completed or cancelled. The task bubble shows only parent-agent tasks;
sub-agent task groups stay with the narrative timeline where delegated work is
attributed. It is separate from the Plan tab.
_Avoid_: Scope task list

### Terminal tab
A repeatable right-panel tab that represents one **shell session** against
the active **terminal scope** (a thread when one is active, otherwise the
workspace root). Creating another shell session creates another Terminal
tab. Selecting a Terminal tab shows only that tab's shell session. Closing
a Terminal tab closes its shell session and terminates the entire process
tree rooted at that shell. If closing it leaves no right-panel tabs, the
right panel closes. When a shell exits on its own, its Terminal tab may show
the exit status briefly, then closes automatically.

### Terminal scope
The thread or workspace a shell session runs against. When a thread is
active, shells open in that thread's working directory (worktree or
workspace root per composer mode). With no thread, the scope is the
workspace and shells open at the workspace root.
_Avoid_: Using "thread id" alone when the scope may be a workspace.

### Shell session
A running shell process (e.g. PowerShell, bash) tied to one terminal scope.
Survives thread switches and terminal-tab hides; the process keeps running
until the user kills it or closes its Terminal tab. Closing it terminates the
shell and every descendant process that it started. Output keeps draining
into server-side scrollback even when no terminal view is mounted.
_Avoid_: PTY (implementation term), terminal instance (ambiguous with the view).

### Active shell
The shell session represented by the selected Terminal tab. At most one
terminal view exists in the app. Its view may stay warm while its Terminal tab
or the right panel is hidden; all other shells run without a view.
_Avoid_: Mounting a view for every open shell (background shells stay
server-side only).

### Terminal view
The in-app rendering of one shell session's output in the Terminal tab.
Only the **active shell** has a view; others keep running without one. Hiding
the terminal surface preserves that view for a fast return. Switching shells
replaces it. A returning view follows the latest output when the user was at
the tail, or restores the same retained content when the user was reading
history. Restoration preserves terminal text and ANSI styling without exposing
control-sequence fragments as visible characters.
_Avoid_: xterm (implementation term), conflating with shell session.

### Scrollback
How many lines of shell output are retained for a shell session, set by
`terminal.scrollback`. The same limit applies on the server (for replay when
the terminal view remounts) and in the mounted terminal view. Output beyond
the limit is dropped oldest-first.
_Avoid_: Treating scrollback as a client-only display setting.

### Review tab
The right-panel tab that shows code changes. **Dual-scope**: its
git-working-tree views (Unstaged, Staged, Commit, Branch) read the
**workspace root** and need no thread; its turn views need a thread. Each
view renders exactly one diff; there is no eager render of every turn's
diff.

### Files navigator
The collapsible file-tree surface within Review, labelled **Files** in the UI.
When sourced from a [[Comparison]], it lists only that comparison's changed
files and navigates within the same diff. The Files navigator is distinct from
the Comparison and its diff; its stable name leaves room for other sources,
such as project files, without renaming the surface.
_Avoid_: Worktree files, Changed files (names for a source, not the surface)

### Comparison
What a Review view *is*: a **base** (before) and a **target** (after) that
resolve to exactly one diff. Some comparisons have **fixed** operands the
user cannot change (Unstaged = index→worktree; Staged = HEAD→index); others
have **picked** operands the user chooses through a picker that still
resolves to a single diff — never N diffs at once. The picked comparisons
are **Branch** (the current branch fixed on the left → one selected comparison
ref on the right; the right side is the only picker), **Commit** (one commit
chosen from a searchable list; default is the latest commit), and the turn
**picker** (one turn's diff).

### Last turn
The most recent turn's diff — the default glance when a thread is active.

### Summary
An AI-written prose recap of the **Cumulative** diff. Not a comparison — a
**lens**: a toggle that re-renders the Cumulative view's changes as prose in
place (diff ⇄ summary), rather than a separate view you pick in the switcher.
Gated behind the diff-summary setting.

### Cumulative
A thread's **net effect since it started**, committed *and* uncommitted, as
one diff (the turn-snapshot before the thread's first turn → the snapshot
after its last). A different **axis** from Branch: Cumulative is measured on
the turn-snapshot timeline and includes uncommitted work, whereas Branch is
measured between git refs and shows committed history only. The two coincide
only when the thread committed everything and its base has not moved.
_Avoid_: "net diff versus base" (that phrasing collides with Branch).

**All turns** is the user-facing label for this view; the toolbar switcher
says _All turns_, while the code, the view id (`cumulative`), and this
glossary keep the name _Cumulative_, mirroring the _Project_ (UI) /
_Workspace_ (code) split.

## Open-in app

### Open-in app
An external application mcode can open the current working directory in: an
**editor** (VS Code, Visual Studio, Cursor, Zed), a **terminal** (Windows
Terminal, Git Bash, WSL), a **git GUI** (GitHub Desktop), or the system
**File Explorer**. Distinct from the in-app right-panel tabs — an open-in
app launches a separate program against the directory, it does not embed.

### Default open-in app
The open-in app that the dedicated shortcut and the split button's primary
action open without the user choosing from the menu. Resolved per thread in
three tiers: a **thread override** (the app last picked from *that thread's*
menu, sticky to the thread) wins; otherwise the **global default** from user
settings; otherwise an **auto-resolution** to the highest-priority installed
editor, falling back to File Explorer. Choosing an app from a thread's menu
sets the thread override only; it never changes the global default, which is
configured in Settings.

## In-app browser preview

### Preview
The embedded in-app browser panel that renders a web URL or a local file.
It is the **Browser** tab type within the workspace-global right panel.
Distinct from opening the page in the user's external browser.

### Browser automation
Provider-neutral agent control of a live Preview tab. Browser automation uses
the same page the user can see, so agent actions, page state, and debugging
evidence stay attached to one shared browser session.
Providers use the typed, scoped Browser v2 gateway. It is the only supported
automation path.
_Avoid_: a hidden agent-only browser

### Browser automation host
The running Mcode client that makes its live Preview tabs available for Browser
automation. A host advertises only tabs that it currently owns and can stop
advertising a tab when that page is replaced, discarded, or closed.
_Avoid_: treating a saved Preview tab record as a live automation target

The host routes every Browser v2 command through one client-side
`BrowserSessionDriver`. The driver selects the web or Electron runtime adapter;
the adapter owns runtime execution while the Electron kernel retains Chromium
and CDP mechanics. `BrowserTargetRegistry` owns logical target identity outside
React. React attaches or detaches runtime handles and projects registry state;
ordinary remounts do not release a logical target. Authoritative tab, thread,
and workspace deletion releases the record. The broker remains responsible for
credentials, routing, cancellation, capacity, and liveness, while MCP remains
schema and authority translation.

### Browser controller
The current actor with control of a Preview tab: the user, an agent, or neither.
Direct user input takes control from the agent and stops the active Browser
automation action for that tab.
_Avoid_: allowing agent input to compete with user input

### Browser automation snapshot
A bounded, point-in-time description of a Preview tab for an agent. It can
include visible text, interactive elements, accessibility information,
diagnostic entries, recent actions, and a screenshot. Truncation is part of the
snapshot so the agent can tell when it received a partial view.
_Avoid_: treating a snapshot as a permanent page model

### Browser diagnostic entry
A bounded console or network observation captured from a live Preview tab for
agent debugging. Sensitive URL details are removed before the entry crosses the
Preview boundary.
_Avoid_: exposing raw browser debugging protocol traffic to a provider

### Preview annotation
A saved request anchored to part of the Preview page. It can carry note text,
proposed changes for that page target, or both; the annotation bubble is only
the editor, and an unsaved bubble is not a Preview annotation yet. Its delete
control belongs inside the opened annotation bubble so passive markers are
harder to remove accidentally.
_Avoid_: treating annotation-bubble styling as the requested page change

### Draft annotation
An unsaved annotation bubble on the Preview page. It has no display number,
does not belong to the Preview annotation set, and can become a Preview
annotation once it has note text or proposed changes.
_Avoid_: treating draft annotations as sendable annotations

### Annotation change summary
The generated text that describes proposed changes on a Preview annotation
when the user did not write note text. It lets visual-only annotations remain
readable in the annotation bubble and Annotation bundle.
_Avoid_: requiring note text merely to explain a visual change

### Visual proposal
The Preview-only rendering of proposed visual changes for a page target. It
shows what the user is asking for without making the live page state the source
of truth. When several saved annotations are visible, only the active annotation
shows its full Visual proposal.
_Avoid_: treating visual proposals as applied page edits

### Annotation display number
The visible number shown on a Preview annotation marker and in the Annotation
bundle. It is unique within the thread's current Annotation bundle, but it may
change when annotations are deleted or reordered. Numbers follow creation
order across the bundle; editing an annotation does not move it.
_Avoid_: treating the display number as the annotation identity

### Preview annotation snapshot
A frozen full-viewport Preview capture associated with a Preview annotation
when the user saves it. It preserves the page state the user saw, even if the
live page later reloads or changes; editing and saving the annotation replaces
its snapshot. It includes the annotation bubble and a highlight for the related
page target.
_Avoid_: keeping annotation snapshot revision history

### Preview page identity
The normalized page target used to decide where Preview annotations appear.
It ignores fragments, query order, and tracking noise while still separating
distinct page states such as different product or route parameters.
_Avoid_: exact raw URL matching for annotation visibility

### Preview annotation set
The saved Preview annotations waiting to be sent with the next user message.
Each annotation is displayed only on its saved Preview page identity; the set
remains available when Preview navigates elsewhere, Design mode exits, or the
page refreshes. The Preview header can discard annotations for the current page
identity; the whole set clears after the annotated message sends successfully.
_Avoid_: clearing saved annotations before send success

### Annotation bundle
The composer item representing a Preview annotation set as one sendable unit.
It may contain several snapshots underneath, but the user sees a single bundle.
It is counted separately from normal composer attachments and is not an editing
surface; saved annotations are edited from the Preview page where their marker
is visible. Removing the bundle clears the saved Preview annotation set. There
is no user-facing count limit for annotations in the bundle.
_Avoid_: showing each annotation snapshot as a separate composer attachment

### Annotation payload
The structured information sent to the agent for an Annotation bundle. It pairs
each Preview annotation with its display number, page context, target context,
note or change summary, proposed changes, and snapshot.
_Avoid_: relying on screenshots alone for annotation intent

### Preview annotation mode
The Preview state where the user creates and edits Preview annotations. The
UI may label this state as **Design**, but the product concept is annotation
because the notes are sent as page-specific change requests. Saving an
annotation leaves the mode active so the user can create more annotations.
While active, the Preview uses an annotation header with empty and saved states
instead of the normal browser header.
_Avoid_: treating Design as a separate interaction mode

### Preview rendering host
The BrowserSurfaceHost owns each preview tab's live Chromium page. Electron
uses renderer-owned `webview` elements. The web runtime uses iframes. There is
no runtime host setting or compatibility fallback.

### Preview tab
One navigable page within the preview, belonging to a thread. A thread can
hold several tabs; exactly one is the active tab at a time.

### Active tab
The preview tab currently shown to the user. The other tabs in the thread
are background tabs.

### Panel visibility
Whether the preview panel is currently in view. When the user collapses or
navigates away from the preview, the panel is **hidden** even though its
tabs still exist. Visibility is distinct from which tab is active: the active
tab of a hidden panel is not on screen.

### Warm tab
A preview tab that holds a live page in memory and is instant to view.
Background warm tabs keep their page intact (scroll position, form input)
but are throttled while not in view.

### Cold tab (discarded tab)
A preview tab reduced to placeholder information - its title, URL, and
favicon - with its in-memory page released to reclaim memory. Reopening a
cold tab reloads the page from scratch, so scroll position and form input do
not survive. This is the same idea modern browsers call a *discarded* or
*sleeping* tab; Mcode uses **cold** / **discarded**, never "disabled".

### Tab discard
Demoting a warm tab to cold to save memory. The inverse - showing a cold tab
again - is **re-warming**, which reloads the page. The active tab is never
discarded while the panel is visible; once the panel is hidden it may be
discarded like any other tab.

### Preview page state
The status of a preview tab's page from the user's point of view:
**loading**, **loaded**, **error**, or **discarded**. Exactly one applies at
a time.

### Preview error state
The page state shown when a tab fails to display a live page: the site is
unreachable (network or TLS failure), the server returned an HTTP error
(404, 500, and similar), the local file is missing, or the page crashed. The
user is offered recovery actions (retry, edit the address, go back, open
externally) rather than a raw browser error page.

## App-side extensibility

Three end-user-facing extensibility surfaces inside the running Mcode app.
Each shares a name with a dev-tooling concept used by contributors who
develop Mcode itself (documented in `AGENTS.md`); the entries here refer
to the runtime, user-facing version only.

### @ mention
A composer reference inserted from the `@` mention picker. Mentions are typed
and rendered as highlighted references in the composer and user transcript: a
file mention references a workspace file, while a sub-agent mention requests a
provider agent for part of the turn.
_Avoid_: treating every `@...` string as a file path.

### Selectable provider agent
A provider-defined agent offered through the `@` mention picker. The list may
combine provider-returned registrations with standalone agent definitions,
but Mcode does not invent provider-internal built-ins that the provider did not
return. Suggestion metadata helps the user choose an agent; the provider remains
authoritative when resolving the selected agent name.
_Avoid_: Sub-agent run, built-in agent

### Provider catalog entry
An invocable provider-owned item offered through the composer. Each entry is
exactly one Skill, provider plugin, Codex custom prompt, or provider command.
Mcode-level commands are not provider catalog entries. Entries of different
kinds may share a native name and remain distinct.

### Provider plugin
A provider-distributed bundle of reusable instructions and integrations. Mcode
exposes an installed and enabled plugin as one provider catalog entry while
keeping its constituent Skills distinct.
_Avoid_: Skill, plugin marketplace entry

### Provider catalog snapshot
The last provider-confirmed set of catalog entries for a workspace context. A
snapshot remains available across app restarts and is marked stale whenever
Mcode cannot confirm it against the provider. Age alone does not expire a
snapshot.

### Catalog refresh
A background reconciliation between a visible catalog snapshot and its
sources. Cached entries remain usable during refresh, and additions, changes,
removals, and diagnostics are applied by stable entry identity.

### Skill
A reusable agent capability the end user can attach to their threads
inside the Mcode app — domain knowledge or a multi-step workflow the
agent loads on demand. Skills are surfaced via `SkillInfo` records and
the skills store. Distinct from the dev-tooling skill concept under
`AGENTS.md` (which is for contributors developing Mcode itself).

A provider may be the **authoritative source of its own skill catalog**
(Codex exposes one natively, including skills bundled inside provider
plugins). When the Codex catalog is temporarily unavailable, Mcode serves
the last confirmed catalog snapshot and marks it stale. Without a snapshot,
the catalog is unavailable. Mcode does not reconstruct the Codex skill
catalog with a filesystem scan. Skills the user disabled in the provider's
own config do not appear in Mcode. An installed and enabled **provider
plugin** is a distinct provider catalog entry. Skills contributed by that
plugin remain separate Skill entries.

### Slash command
A short command the user types in the composer (e.g. `/something`) that
the Mcode app expands into a richer prompt or action. Editor integration
lives in the composer's Lexical plugin (`SlashCommandPlugin`,
`SlashCommandNode`, `SlashCommandPopup`). Distinct from the dev-tooling
slash commands under `.claude/commands/` etc. (which are for
contributors).

### Codex custom prompt
A deprecated Codex prompt template that the user invokes explicitly through
the slash-command gesture. Mcode continues to support custom prompts as a
compatibility surface, while Skills remain the preferred Codex surface for
reusable instructions.
_Avoid_: Skill, Mcode-level command

### Provider command
A reusable command defined by an agent provider, such as a Claude command.
Provider commands are distinct from Codex custom prompts, even when both use
the slash-command gesture in the composer.
_Avoid_: Codex custom prompt, Skill

Slash commands use `/` as their composer gesture. Providers with their own
native invocation syntax (Codex's `$` mentions) get a translation at the
provider boundary; the user never types the native syntax in Mcode.

Slash commands sit in one of three availability layers:

- **Provider-scoped command** — native to a single provider, discovered by
  the server skill scan. Each `SkillInfo` carries the provider(s) that own
  it in `providers[]`, and the server (`skill-service.ts`) filters the list
  by the active provider before it reaches the client. The composer does
  **not** re-filter these; they arrive already scoped.
- **Multi-provider command** — offered to an explicit, growing set of
  providers. `/goal` is backed by provider goal support, while `/plan`
  applies to every provider except Copilot, which has its own native plan mode.
  Capability availability is resolved once by `resolveComposerCapabilities`
  and shared by the plus menu, slash commands, and attached chips.
- **Mcode-level command** — app-level, offered for every provider regardless
  of which one is active (e.g. `/compact`).

Built-ins are the only commands the client gates by provider; provider-scoped
skills are gated server-side. An empty `providers[]` on a `SkillInfo` means
*no* provider, not "all" — universal availability is the Mcode-level layer.

### Hook
A user-configurable script that fires at a specific point in an agent's
lifecycle within a thread. Two kinds today:

- **Permission hook** — runs before a tool call to gate it. The hook can
  **allow** the call (optionally with a *modified input*) or **deny** it.
  The allow-with-modified-input capability is part of the underlying
  protocol — even though current implementations primarily exercise plain
  allow/deny, the modify path is real and worth keeping in mind when
  designing new hook UX or features.
- **Stop hook** — runs after a turn ends. Useful for verification,
  notifications, or post-processing.

Distinct from the dev-tooling stop hook under `AGENTS.md` (the harness
verification gate for contributors).

## In-app browser preview

### Discarded tab (memory saver)
A background preview tab whose renderer has been killed to reclaim memory,
keeping only a cold placeholder (title, URL, favicon). Reopening reloads the
page; scroll position and form state are not preserved. Governed by
`preview.memorySaver.*` settings and ADR 0002.

## Release channels

### Stable release
A supported Mcode version published for general use.
_Avoid_: Major release, production release

### Nightly release
A prerelease build published from ongoing development for early use and
testing.
_Avoid_: Stable release

### Superseded nightly
A nightly release whose intended version has since shipped as a stable release.
It has no continuing rollback or support role.
_Avoid_: Supported release, archived nightly
