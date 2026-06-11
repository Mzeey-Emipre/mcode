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

### Protocol adapter
The per-Provider seam carrying the protocol-specific I/O the Session runtime
delegates to: `spawn` (returning the session state plus any child PIDs the
runtime should attach/kill), `isBusy` (the eviction guard), `interrupt`
(protocol-level graceful stop), `close` (provider teardown short of the OS
kill), and `isStale` (whether a pooled session must be discarded before
reuse). Each Provider *is* its own Protocol adapter (the Provider class
implements the interface); composition with the Session runtime, not
inheritance.

## Workspaces and worktrees

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
an isolated checkout of the repo on its own branch. Standard git semantics
— one repository, multiple working directories — applied as an isolation
primitive: each worktree-mode thread runs against its own files, its own
branch, and (in dev mode) its own database.

**A worktree is not 1:1 with a thread.** Multiple threads can share the
same worktree via the composer's "Existing worktree" mode. A thread can
also run *without* a worktree, directly against the workspace's main
checkout — see "Direct mode" below.

Worktrees are persistent and removed manually. When a user deletes a
thread, an option to delete its worktree is offered alongside; the
worktree can also be kept and reused for future threads.

### PR-able thread
A thread the app can open a pull request from. A thread is PR-able only
when it runs in an isolated worktree; direct-mode threads are never
PR-able, because they run against the workspace's main checkout and there
is nothing to open a pull request from. This single notion gates every PR
affordance: the thread-row PR icon, the chat header's Create PR button,
and the background PR and commits-ahead polling. A non-PR-able thread
shows its branch/agent status instead of a PR glyph, offers no Create PR
button, and is never polled against GitHub, even if a PR number happens to
be attached to it. A user who wants a pull request from local work creates
a worktree.

## Composer

### Composer mode
The mode the composer is in when the user creates a new thread, determining
whether the thread runs against the workspace's main checkout or against a
worktree, and whether that worktree is new or pre-existing. Three modes:
**Direct**, **New worktree**, **Existing worktree**. Once a thread has been
created, its mode is fixed for the life of the thread — the composer shows
the chosen mode in read-only form rather than as a fourth mode.

### Direct mode
Composer mode where the thread runs against the workspace's main checkout.
No isolation: file edits affect the user's primary working directory and
current branch. The default when a workspace is not a git repo.

### New worktree mode
Composer mode where the thread provisions a fresh git worktree on a new
branch. Used when the user wants isolation and a clean branch for the work
about to be done. Code identifier: `"worktree"`.

### Existing worktree mode
Composer mode where the thread attaches to a worktree that already exists.
Enables multiple threads to share one worktree — e.g. follow-up work on
the same branch without re-creating the directory.

### Naming mode (Auto / Custom)
Sub-control of New worktree mode controlling how the new branch is named.
**Auto** generates a branch name from the thread's first message;
**Custom** lets the user type one explicitly. Auto is the default, but the
user can change the default to Custom from settings.

### Composer session
The composer's per-thread state, treated as one value: draft text,
attachments, model, provider, reasoning level, composer mode,
access/permission mode, context window, and provider-specific toggles. Owned
by one module whose interface is **snapshot** (save the outgoing thread's
session) and **restore** (install the incoming thread's session as a single
state transition). Switching threads is one restore; the editor update is an
implementation detail behind the seam. (Epic #649, slice #655.)

## Interaction modes

The two modes a thread can be in. Mutually exclusive; orthogonal to the
composer mode and to model configuration.

### Plan mode
A thread state where the agent produces a structured plan instead of
executing changes. The agent reasons, searches the codebase, drafts a plan
document, and presents it for the user to approve, revise, or reject.
Exited via the SDK's `ExitPlanMode` tool, after which the thread switches
to Build mode and the agent can act on the plan.

### Build mode
The opposite of Plan mode: the thread state where the agent actually
performs the work — editing files, running tools, making changes. The
default for new threads when the user does not opt into Plan mode.

> **Codebase mismatch (rename pending).** The `AgentDefaultModeSchema`
> still exposes a deprecated third `"agent"` value that should be dropped —
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
`max`, `xhigh`, `ultrathink`. Each provider maps the value to whatever its
SDK supports — Claude uses these directly (with `max` mapping to extended
thinking on supported models), Codex maps `none`/`minimal` to its own
presets, and Copilot honours the level per model capability. The Cursor
provider does not expose a reasoning-level selector — its models manage
reasoning internally.

**Ultrathink** is a virtual top tier: it prepends `Ultrathink:\n` to the
user's prompt and sends `max` effort to the SDK underneath. Supported
only on max-tier Claude models.

## Chat threading

### Thread
A single chat conversation between a user and an AI agent. Threads belong to
workspaces and run against a provider. Distinct from a git branch even though
threads can be associated with a worktree.

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

## Chat lifecycle

### Turn
One round of agent execution within a thread, bounded by a `TurnStarted`
event and a `TurnComplete` event. A turn always begins with one user
message; the agent then does whatever work it needs (streaming thoughts,
calling tools, reading files, dispatching sub-agents) before producing its
final response. Everything from the user message to the final agent
response is the **same turn**, no matter how many intermediate steps
occurred. Costs, token counts, and tool-call sequences are attributed
per-turn, and several pieces of client-side state are scoped to the current
turn.

### Tool call
A single tool invocation the agent makes during a turn (e.g. `Read`,
`Bash`, `Grep`, `Edit`). Each tool call has an input, a result, and a
completion status, and renders as one row in the narrative timeline.
Multiple tool calls can run in parallel within the same turn. All
user-visible tool calls are domain tool calls; internal SDK plumbing is
not.

### Sub-agent
A tool call of a special kind: the agent dispatching another agent to do a
focused task and report back. Sub-agents may run in parallel and may
themselves dispatch further sub-agents (nested). Each sub-agent's events
are attributed to its parent via `parentToolCallId` so the narrative
timeline can nest them correctly.

Sub-agent calls are **always shown** in the user's timeline; the user
should be able to tell when the agent has handed work to a sub-agent. From
the user's point of view, a sub-agent is still part of the same turn as
the parent.

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
How a turn ended, as one of three mutually-exclusive states:
**completed** (the agent finished its work normally), **errored** (the turn
failed — a crash, a provider error, a spawn race), or **cancelled** (the
user stopped the turn). The outcome is what the end-of-turn decision keys
off: a cancelled turn and an errored turn record different tool-call
statuses, so a running tool call can tell whether it was stopped by the user
or killed by a failure.

> **Codebase mismatch (distinction pending).** The turn-end paths today
> carry a bare `isError` boolean, which collapses *errored* and *cancelled*
> into one state. The three-way outcome replaces it so the two are no longer
> conflated.

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
fatal failure that will recur. A transient failure is eligible for one
automatic retry against a fresh session, gated by an attempt cap so a
misclassified fatal error cannot cause a retry storm. Which signatures count
as transient is a small explicit allowlist, not a heuristic.

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
declares `sessionForkOnResume: "clean"` (Claude, Cursor).

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
  Cursor)
- **unsupported**: provider can't fork sessions; pipeline goes directly to
  path D (Codex, Copilot today)

### Per-turn input cap
The maximum input characters a provider accepts per turn. Declared as
`maxInputCharactersPerTurn`. Decorative for Handoff purposes since Handoff
delivery went off-band (see `Handoff delivery`); retained as Provider metadata.

### Goal support
The ability to set, show, and clear a standing **goal** — a condition the
agent keeps in view across turns — exposed to the user through `/goal`. Goal
support is a **capability a provider has**, not a provider it is: a provider
either implements the goal capability or it does not. On a provider that
lacks it, `/goal` passes through to the model as plain text so the model
still sees what the user typed. Claude implements it today; Codex is the
planned next implementer (matching the `/goal` Multi-provider command entry
under `Slash command`).

## Server runtime

### Thread-scoped push
The routing rule for server-pushed events: a client declares which threads
it is watching, and an event carrying a thread id is delivered only to
clients subscribed to that thread. Events without a thread id remain
broadcast to every client. A window watching one thread never receives
another thread's streaming traffic; on a thread switch the client
resubscribes and hydration covers the gap. Payload validation at this seam
has two adapters: validating (dev, logs schema drift) and pass-through
(production). (Epic #649, slices #656/#657.)

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

### Cross-provider switch (deferred)
Swapping a thread's provider mid-conversation. Uses the same handoff
primitive as a fork but with the implicit anchor being the thread's last
message, and the same thread continues with the new provider. Not yet
implemented; was a deferred item in the chat-fork handoff feature (PR #499).

### Compaction
A separate mechanism that summarizes a thread's older turns into a single
compact summary stored on the thread itself, used to keep long threads
within their own provider's context window. Distinct from a fork handoff,
though the orchestrator does consult `last_compact_summary` when building a
deterministic path-D handoff.

## Right panel

### Right panel
The workspace-level surface docked to the right of the chat, hosting a set
of typed tabs (Browser, Terminal, Review, Scope, and later Files). The
panel itself — its visibility, width, and active tab — is **workspace-global**
and persists with no thread open. Each tab type sets its own availability:
some (Browser, Terminal) run against the **workspace root** when no thread
exists; others (Scope) require a thread. This replaces the former model
where the entire panel was thread-scoped and could not render without a
thread. (Per-tab *content* scope — e.g. whether a thread keeps its own
Browser tabs — is defined on each tab type below, not here.)

### Tab availability
The rule set governing which tab types a user can create at a given moment.
Every top-level tab is a **singleton** — at most one Browser, one Terminal,
one Review, one Scope, one Files. Multiplicity lives *inside* a tab (the
Browser holds many pages, the Terminal many shells), never as duplicate
top-level tabs. The set of **creatable** types is filtered twice: by
**scope** (types needing a thread are dropped when no thread is active) and
by **cardinality** (singletons already open are dropped). When exactly one
type is creatable, the add affordance opens it directly instead of showing
a menu; when none are, the add affordance is hidden. The empty panel and
the add menu present this same creatable-types set.

### Review tab
The right-panel tab that shows code changes. **Dual-scope**: its
git-working-tree views (Unstaged, Staged, Commit, Branch) read the
**workspace root** and need no thread; its turn views need a thread. Each
view renders exactly one diff; there is no eager render of every turn's
diff.

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

### Skill
A reusable agent capability the end user can attach to their threads
inside the Mcode app — domain knowledge or a multi-step workflow the
agent loads on demand. Skills are surfaced via `SkillInfo` records and
the skills store. Distinct from the dev-tooling skill concept under
`AGENTS.md` (which is for contributors developing Mcode itself).

### Slash command
A short command the user types in the composer (e.g. `/something`) that
the Mcode app expands into a richer prompt or action. Editor integration
lives in the composer's Lexical plugin (`SlashCommandPlugin`,
`SlashCommandNode`, `SlashCommandPopup`). Distinct from the dev-tooling
slash commands under `.claude/commands/` etc. (which are for
contributors).

Slash commands sit in one of three availability layers:

- **Provider-scoped command** — native to a single provider, discovered by
  the server skill scan. Each `SkillInfo` carries the provider(s) that own
  it in `providers[]`, and the server (`skill-service.ts`) filters the list
  by the active provider before it reaches the client. The composer does
  **not** re-filter these; they arrive already scoped.
- **Multi-provider command** — offered to an explicit, growing set of
  providers. `/goal` (Claude today, Codex planned) and `/m:plan` (every
  provider except Copilot, which has its own native plan mode) are built-ins
  in this layer. Their availability is declared per command in
  `useSlashCommand` (`BuiltinCommand.isAvailable`), not scattered as inline
  conditionals.
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
