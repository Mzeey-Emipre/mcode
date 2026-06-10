---
status: accepted
---

# The Branch comparison defaults context-dependently and always uses three-dot range semantics

## Context

The Review tab's git views are moving from fixed diffs to **comparisons** — a
base ref and a target ref that the user can pick (see `CONTEXT.md` → Comparison).
The Branch comparison is the first with two user-selectable sides, which forces
two decisions a casual reader would otherwise assume the opposite of:

1. **What does Branch compare by default?** The obvious answer — "the current
   branch against its remote" (`current → origin/current`) — answers *"what
   haven't I pushed,"* a pre-push check. But the panel's job is reviewing an
   agent thread's work, where the question is almost always *"everything this
   branch changed since it forked."* Those are different diffs, and on a freshly
   created agent branch with no upstream the remote-based default is empty.

2. **Two-dot or three-dot range?** `base..HEAD` (two-dot) shows every commit
   reachable from HEAD but not base — which includes commits that landed on
   `base` after the fork if HEAD hasn't merged them, producing a noisy,
   misleading "review" diff. `base...HEAD` (three-dot) shows only what changed on
   HEAD's side *since the two branches diverged*, which is what a reviewer means
   by "this branch's changes."

The branch is frequently a thread's worktree branch, which is rarely pushed, so
any origin-based default would fall back constantly in the common case.

## Decision

**Default is context-dependent:**

- **Current branch ≠ detected base** → `base → current` (e.g. `main...feat/x`).
  Review the whole branch's work. (This is the pre-existing `branchDiff`
  behavior.)
- **Current branch == detected base** (you are *on* `main`) → `current →
  origin/current`. `base...HEAD` is empty there, so the only meaningful default
  is divergence from the remote.

`current → origin/current` remains available as a **manual preset** in the ref
picker for the non-default-branch case; it is just not the default there.

**Range semantics are always three-dot** (`base...target`). The picker never
issues a two-dot range.

**Edge-case fallbacks** (each resolves to a sensible non-empty or explicit-empty
state, never an error):

- **No `origin` remote** → `base → current`.
- **No upstream for the branch** (never pushed) → `base → current`.
- **Detached HEAD** (no branch name) → merge-base(base, HEAD) → HEAD.
- **Unborn branch / zero commits** → explicit empty state.
- **`detectDefaultBranch` finds no `main`/`master`** (e.g. `develop`, `trunk`) →
  use the detected default; if none, the picker opens with no base and the user
  selects one.
- **In-thread scope** → "current branch" is the thread's worktree branch; the
  default is `base → thread-branch`, not the origin-based variant.

## Considered Options

- **Default `current → origin/current` (rejected as the default).** Answers
  "what's unpushed," not "what did this branch change." Empty on unpushed agent
  branches, which is the common case. Kept as a selectable preset.
- **Default `base → current` everywhere, including on the base branch
  (rejected).** Clean single rule, but on `main` it yields an empty diff and the
  user has nothing to look at — the one place the remote comparison is the only
  useful one.
- **Two-dot range (rejected).** Simpler mental model for some, but pulls in
  post-fork commits on the base side and misrepresents "this branch's changes."
- **Context-dependent default + three-dot (chosen).** Matches what a reviewer
  means in each situation at the cost of a branching rule a reader must not
  "simplify" into one case.

## Consequences

- Server `branchFiles`/`branchDiff` generalize from an implicit `base...HEAD` to
  an explicit `(base, target)` pair; the context-dependent default is resolved
  before the call, not buried in the git command.
- The default rule has two arms and several fallbacks; a future reader should not
  collapse it to a single comparison "for simplicity" — each arm exists because
  the other produces an empty or misleading diff in its case.
- Three-dot is a deliberate, load-bearing choice; switching to two-dot would
  silently change what every Branch review shows.
