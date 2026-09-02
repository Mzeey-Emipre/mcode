# Product

*For contributors. The README tells you what Mcode is in a sentence. This document tells you why it exists, who it serves, what jobs it does, and the lines we choose not to cross. Read it once before you scope a feature.*

---

## Register

product

## 1. What Mcode Is

Mcode is a desktop app for running coding agents — many at a time, across many projects, against many branches. You point it at a folder, pick a provider (Claude, Codex, Copilot, Cursor, OpenCode), and you get a workspace where each conversation is a thread, each thread can have its own git worktree, and every tool call the agent makes is visible in real time.

It is not a chat client and it is not a wrapper. The CLIs already work. Mcode exists because *running eight agents in parallel from a terminal is unworkable* — you lose track of which one finished, which one errored, which branch each one is on, which diff each one produced. Mcode is the orchestration surface that sits above all of them.

## 2. Who It's For

One person, holding their attention:

- **Senior developers** who already use coding agents daily and have hit the wall of "how do I keep five of these going without losing my mind?"
- **Solo founders and indie engineers** running parallel experiments across multiple repos.
- **Power users** who keep an editor, a terminal, a browser, and a notes app open simultaneously and want Mcode to fit next to those, not replace them.

Not for:

- People who have never used Claude Code, Cursor, or Codex from a terminal. The mental model is too dense.
- Teams looking for a multi-user review system, team policy enforcement, or repository administration.
- People who want a single chat box with no concept of branches, threads, or worktrees.

## 3. The Jobs Mcode Does

In rough order of frequency:

| Job | What happens | Why Mcode beats the CLI |
|-----|--------------|-------------------------|
| Run an agent on a fresh branch | Pick provider, choose **New worktree** mode, type the prompt, submit. A worktree is provisioned and the agent starts. | One action vs. five terminal commands. The worktree is named, tracked, listed. |
| Track multiple agents at once | Sidebar shows every thread across every project with a status dot (idle / running / errored). | A terminal cannot show eight sessions at a glance. |
| Review what an agent did | Diff panel renders per-turn file changes; side-rail jumps straight to the file in the user's editor. | The CLI's diff output scrolls past and is gone. |
| Review a pull request | The Pull requests surface groups authored, requested, and reviewed work, then exposes Summary, Timeline, Code, and an optional isolated Review task. | Remote review and local agent work stay in one explicit flow while GitHub remains the system of record. |
| Follow up on a previous run | Fork a thread from any message, or attach a new thread to an existing worktree. | The CLI has no concept of "continue from message N." |
| Hand work between providers | Fork a Claude thread into a Cursor thread; a generated handoff doc carries context across. | Provider sessions don't talk to each other. Mcode's B/A/D ladder bridges them. |
| Inspect an agent's web preview | Preview panel renders the running app; captures regions or full screenshots straight into the next prompt. | No tab-flipping; the screenshot lands in the composer ready to send. |
| Plan before doing | Plan mode produces a structured plan and a question wizard before the agent edits anything. | The CLI just starts editing. |

## 4. The Wedge

The thing Mcode does that nothing else does:

> **It treats each agent run as a first-class object with state — branch, worktree, transcript, diff, status — that you can scan in one second.**

A Claude Code terminal session has no object. It's an ephemeral stream of text. When you start a second one, you're juggling two terminals. Five sessions and you're lost.

Mcode says: *every conversation is a thread, every thread has metadata, every thread sits on the sidebar with a dot showing its state.* Once you commit to that abstraction, everything else falls out — worktree isolation, fork and handoff, per-turn diffs, the preview panel, the command palette. They all reinforce one principle: **the agent's work is something you can hold and reason about, not just talk to.**

## 5. Product Principles

Five things that decide ambiguous design or scope calls:

### 1. The glance matters more than the conversation.

Most of the time, the user is not reading the agent's reply. They're glancing at the sidebar to see what's done, what's running, what errored. Optimize for the glance. A status dot you can read at flick-speed is worth more than a paragraph of agent prose.

### 2. Information density over uniform compression.

Prefer high information density, not tight spacing everywhere. Keep rows compact within a related list, but use stronger spacing between groups, task stages, and primary surfaces. Whitespace is structural when it communicates hierarchy, focus, or ownership. Do not add onboarding tooltips for standard icons. Use tooltips when they reveal clipped data, such as a full file path, or name an icon-only action whose label is not otherwise visible. Do not wrap content in cards only to add space or containment.

### 3. The agent is a peer, not an oracle.

The user is in charge. They edit the prompts, they pick the branch, they choose when to fork, they decide what to ship. The agent runs; the user steers. Mcode does not narrate the agent's wisdom or hide its mistakes — it shows what happened, exactly, in the order it happened.

### 4. Keyboard first, mouse fallback.

Every action has a keystroke. F2 renames in place, Cmd+1..9 switches threads, Cmd+K opens the palette, slash commands fire from the composer. If you design a feature without a keyboard path, you haven't finished it.

### 5. Quiet over loud.

The interface stays calm at rest. During a state change, one signal leads: a dot pulses, a row enters, or a number ticks. Supporting motion may preserve continuity or show cause and effect, but it shares the same timing and does not compete with the data.

### 6. Anticipate the next step.

At every node of the loop, the app surfaces the one move the user is most likely to make next. When the outcome is unambiguous it just happens (add a project, land in a new chat on it); when there is a real choice it offers a single primary action and keeps the rest quiet (a finished turn offers View diff; an errored one offers Re-run). The suggestions are curated, not learned, so the same state always proposes the same move and the user comes to trust it. The goal is not cleverness. It is that the user rarely has to stop and ask "what now?"

### 7. Same tool, different posture.

Responsive changes preserve capability, context, and state. A file navigator
can dock beside a diff when there is room and float over it when there is not.
It does not become a weaker picker or a separate workflow just because its
container narrowed. Layout adapts continuously as panels resize, without
requiring the user to close and reopen the surface.

## 6. The Surfaces

A user with Mcode open sees, in priority order:

| Surface | What it does | Why it earns its space |
|---------|--------------|------------------------|
| **Sidebar** | Projects, threads, status dots, drag-reorder | The thing the user scans first, every time. |
| **Conversation** | Narrative timeline of turns, tool calls, narration segments. Read-only — replies go through the composer. | The agent's stream, made legible. |
| **Composer** | Drafting surface at the bottom of the conversation. Owns mode (Plan / Build), branch, worktree, attachments, model, reasoning level. Persists drafts across thread switches. | The user's only input. Treat it like a workbench. |
| **Plan-mode wizard** | When Plan mode is active, the composer transforms into a step-by-step question flow before any work begins. | Structured planning, not free-form chat. |
| **Preview panel** | Embedded browser pointed at the running app. Has a **design mode** (manual inspection, gates the main submit button) and a **capture dock** (screenshot regions or elements into the composer). | Visual loop without leaving the app. |
| **Diff panel** | Per-turn file changes, side-rail to open in editor, whole-file Markdown preview. | Reviewing what the agent did is the second most common action after sending a prompt. |
| **Pull requests** | Relationship inbox with Summary, Timeline, Code, explicit Remote effects, and Review Change Stack. | Review a remote Change stack or continue it in an isolated Review task without hiding which system changes. |
| **Command palette** | Cmd+K. Slash commands, actions, and a jump to Settings. | The keyboard discovery surface. |
| **Right panel** | Terminal as a tab; other auxiliary tabs alongside. | Drop into a shell without leaving the workspace. |
| **Settings** | Appearance, performance, model context overrides, provider keys, permission modes. Reached from the sidebar or the command palette. | Configuration without leaving the workspace. |

## 7. What Mcode Doesn't Do

Explicit non-goals. Saying no to these is what keeps the surface coherent.

- **No ticket tracking.** GitHub Issues, Linear, Jira exist. We point at them; we don't replace them.
- **No team review policy or repository administration.** Mcode may surface and act on pull-request review. GitHub remains the system of record; Mcode does not own team review policy or administer repositories.
- **No team features.** Mcode is a personal tool. Multi-user, shared workspaces, role-based access are out of scope.
- **No marketing surface.** No dashboards, no "stats", no "your week in Mcode." The app is a tool, not a thing to look at.
- **No model abstraction layer.** We do not reinvent the provider SDKs. We adapt to them. If Claude releases a new feature, we surface it. We do not pretend providers are interchangeable when they aren't.
- **No cloud sync, no accounts, no telemetry.** State lives on disk. Threads, worktrees, settings — all local.
- **No mid-turn chat with the user.** The agent does not ask clarifying questions during a turn. We disallow the `AskUserQuestion` SDK tool (commit 58e1fc39). Plan mode is the structured place for clarification.

## 8. Where We Are

The roadmap lives on a GitHub Project board. Four broad phases, executed solo:

1. **Foundations** — multi-provider runtime, worktree isolation, narrative timeline. *Largely shipped.*
2. **The orchestration loop** — fork and handoff (B/A/D ladder), plan mode, per-turn diffs, preview panel. *In flight.*
3. **The drafting surface** — composer as workbench, slash commands, skills, hooks. *In flight.*
4. **Polish and integrations** — auto-updater, signing, packaging, deeper editor integration. *Backlog.*

In flight as of May 2026:

- **Whisper narrative redesign** — prose-first rendering, vertical rail reserved for nested tool calls. See commit c906a265.
- **Preview panel refinements** — capture dock, design-mode pill, split between main toolbar and dev / debug tools. See commit 91e37a36.
- **Plan-mode wizard** — composer takeover, durable lifecycle, structured question flow. See commit 82fd5eb2.
- **Cursor handoff via provider-generated path** — B/A/D ladder with sessionless B-prime fallback. See commits fb4e7123 and 8bc66d23.

## 9. How to Read the Other Docs

| Doc | When to open it |
|-----|----------------|
| `README.md` | Install, run, prerequisites. |
| `AGENTS.md` | Repo conventions and workflow guidance. |
| `CONTEXT.md` | Domain glossary. If you don't know what a "worktree" or "narration segment" means here, read this first. |
| `ARCHITECTURE.md` | IPC flow, data model, directory layout. |
| `DESIGN.md` | The complete visual and interaction contract: creative direction, tokens, typography, layout, components, states, accessibility, and motion. Read it before changing UI. |
| `docs/specs/` | Formal product specs for individual features (markdown rendering, usage tracking, context window, sort order). |

## 10. The Product Test

Before shipping a feature, hold it against three questions:

1. **Does it earn its pixels?** If it adds chrome without making the glance faster or the loop tighter, cut it.
2. **Does it sound like Mcode in copy?** "Errored", "Idle", "Empty" — not "Oops, something went wrong." Marketing voice in the diff is a bug.
3. **Would a senior developer at 11pm thank you for this, or scroll past it?** That's the audience. That's the test.

---

*The sections below are the strategic design inputs that the impeccable design commands read (`critique`, `polish`, `craft`, and the rest). The visual translation of this strategy lives in `DESIGN.md`.*

## Brand Personality

**Three words: editorial, quiet, instrument-grade.**

The register is editorial and typeset, closer to a well-made code editor or terminal than a CRM or SaaS dashboard. The voice is technical and never consumer-softened: "Errored", "Idle", "Empty", not "Oops, something went wrong." No emoji or hand-holding. The interface stays calm at rest. State changes use one dominant signal, with restrained supporting motion for cause and effect.

The emotional goal: a senior developer at 11pm feels in control and unhurried, reading an instrument, not being marketed to.

### References

Named anchors for the feel, each with the specific quality it contributes and where Mcode deliberately diverges. A reference is a scalpel, not a template: borrow the one quality, not the whole look.

- **Codex desktop app** - the current high-water mark for agent-run UX. Calm presentation of what an agent is doing, restraint over chrome, technical clarity without consumer softening. Borrow the legibility of a run in flight and the refusal to decorate. Diverge where the job differs: Codex centers a single task and a single stream; Mcode's surface must hold many runs at once and optimize for the cross-thread glance, not one conversation.
- **Zed** - the reference for speed and optimization. Performance is treated as a design property, not a backend afterthought: instant response, no jank, density without lag. This anchors Mcode's performance targets (sub-2s startup, under 150MB idle, 60fps narrative timeline). Borrow the discipline. Diverge in register: Zed is a file-centric editor with editor chrome; Mcode sits beside the editor as an orchestration surface, not a replacement for it.
- **T3 Code** ([pingdotgg/t3code](https://github.com/pingdotgg/t3code)) - Mcode's closest peer, a minimal GUI for coding agents (Codex, Claude, OpenCode). Borrow its multi-provider control patterns and, above all, its optimisation discipline: a Vite build, oxlint, a fast-launching desktop shell. Diverge on the wedge: T3 Code centers a single agent view; Mcode exists for parallel orchestration across many worktrees read at a glance, so the sidebar-of-runs and the worktree-as-object stay ours.
- **Synara** ([Emanuele-web04/synara](https://github.com/Emanuele-web04/synara)) - a T3 Code fork that adds broader provider coverage (Gemini, Kilo Code) and a neat multi-tab UI for threads, views, and an embedded browser. Borrow the multi-tab thread/view/browser layout and the breadth of providers. It shares T3 Code's architecture DNA, so treat the two as one design lineage. Diverge the same way: a tab strip is a per-window convenience; Mcode's organizing object is the thread on the sidebar with its status dot, not a tab.

## Anti-references

What Mcode must not look or feel like. If a design wants to convert a visitor, it is wrong.

- **SaaS dashboards and admin panels:** colorful stat chips, the hero-metric template (big number, small label, supporting stats), "your week in Mcode" summaries.
- **The AI-tool aesthetic:** dark mode with neon or cyan accents, purple-to-blue gradients, glassmorphism, gradient text.
- **Consumer chat apps:** speech bubbles, emoji reactions, "typing..." theatrics, soft rounded everything.
- **Marketing-page tropes inside the product:** oversized hero type, tracked-uppercase eyebrows above every section, identical repeating card grids, decorative resting drop shadows, colored side-stripe borders.
- **Consumer error voice:** "Oops, something went wrong." We state what happened, in technical register.

## Accessibility & Inclusion

- **Target WCAG 2.1 AA** on product surfaces. Body text holds at least 4.5:1 against its surface; large or bold text at least 3:1. Muted text must still clear 4.5:1 — do not lighten it "for elegance."
- **Reduced motion is mandatory.** Every animation in `index.css` ships a `prefers-reduced-motion: reduce` alternative, and new motion must too.
- **Never encode state in color alone.** Status dots pair hue with position and label context; diff additions and removals carry gutters and text weight, not just sage or clay, so red/green color-blind users can still read them.
- **Keyboard-first is an accessibility property,** not only a power-user one. Every action has a keystroke and a visible focus ring (cool-ring, 3px).
