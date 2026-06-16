---
status: accepted
---

# The Branch comparison defaults upstream-first and always uses three-dot range semantics

## Context

The Review tab's git views are moving from fixed diffs to **comparisons** — a
resolved ref pair that produces one diff (see `CONTEXT.md` → Comparison).
The Branch comparison fixes the current branch on the left and lets the user
pick the comparison ref on the right. Its default pair still needs two decisions
a casual reader would otherwise assume the opposite of:

1. **What does Branch compare by default?** The obvious answer — "the current
   branch against its remote" (`current → origin/current`) — answers *"what
   haven't I pushed,"* a pre-push check. But the panel's job is reviewing an
   agent thread's work, where the question is often *"everything this branch
   changed since it forked."* Those are different diffs. The default must pick
   the most useful ref for each checkout without always falling back to
   `origin/main`.

2. **Two-dot or three-dot range?** `base..HEAD` (two-dot) shows every commit
   reachable from HEAD but not base — which includes commits that landed on
   `base` after the fork if HEAD hasn't merged them, producing a noisy,
   misleading "review" diff. `base...HEAD` (three-dot) shows only what changed on
   HEAD's side *since the two branches diverged*, which is what a reviewer means
   by "this branch's changes."

The branch is frequently a thread's worktree branch. When it has a tracked
upstream, the unpushed diff is the most actionable default. When it does not,
fall back to the repo's remote default branch so the user still sees the branch's
work since fork.

## Decision

**Default comparison ref priority** (resolved server-side via
`GitService.resolveBranchComparison`):

1. **Tracked upstream** (`git rev-parse --abbrev-ref @{upstream}`) when set.
   On a feature branch this yields `upstream...current` (e.g.
   `origin/feat/x...feat/x`). On the repo default branch this yields
   `current...upstream` (e.g. `main...origin/main`).
2. **Remote default ref** (`origin/<repo-default>` from `origin/HEAD`) when the
   branch has no upstream but `origin` exists. On a feature branch this yields
   `origin/main...feat/x` (or `origin/develop...feat/y`, etc.).
3. **Local default branch** for feature branches in repos with no `origin`
   remote (e.g. `main...feat/x`).
4. **No comparison** on the local-only default branch with no upstream and no
   `origin` remote. The Branch view is **disabled** (`isComparisonAvailable:
   false`) until git state changes (first commit on a feature branch, `origin`
   added, upstream set, etc.). The client re-probes on `diffRevision` bumps and
   when the view menu opens, matching Commit view gating.

`origin/main...feat/x` and other fork-based comparisons remain available as
**manual presets** in the ref picker.

**Range semantics are always three-dot** (`base...target`). The picker never
issues a two-dot range.

**Edge-case fallbacks** (each resolves to a sensible non-empty or explicit-empty
state, never an error):

- **No `origin` remote, feature branch** → local default → current (rule 3).
- **No upstream for the branch** (never pushed) → remote default → current
  (rule 2) when `origin` exists.
- **Detached HEAD** (no branch name) → best available base → HEAD.
- **Unborn branch / zero commits** → explicit empty state; Branch view disabled.
- **`detectDefaultBranch` finds no `main`/`master`** (e.g. `develop`, `trunk`) →
  use the detected default; if none, the picker opens with no base and the user
  selects one.
- **In-thread scope** → "current branch" is the thread's worktree branch.
- **Non-`origin` upstream** (fork remotes, renamed tracking branches) → resolved
  via `@{upstream}`, not by assuming `origin/<branch>`.

## Considered Options

- **Default `origin/<repo-default> → current` for all feature branches
  (rejected).** Always compares against `main` even when the branch tracks its
  own remote ref; hides unpushed work on pushed branches.
- **Default `current → origin/current` via ref-name guess only (rejected).** Breaks
  when upstream is on a non-`origin` remote or the tracking branch name differs.
- **Keep Branch view enabled on local-only default branch with empty diff
  (rejected).** Shows a meaningless empty panel; disabling with recovery on git
  events is clearer.
- **Upstream-first priority + three-dot (chosen).** Matches reviewer intent in
  each situation; `@{upstream}` is the accurate upstream signal.

## Consequences

- Server `branchFiles`/`branchDiff` generalize from an implicit `base...HEAD` to
  an explicit `(base, target)` pair; the priority ladder is resolved before the
  call, not buried in the git command.
- `BranchComparison` carries `isComparisonAvailable` so the client can disable
  the Branch view without guessing from an empty ref pair.
- The default rule has four priority steps and several fallbacks; a future reader
  should not collapse it to a single comparison "for simplicity."
- Three-dot is a deliberate, load-bearing choice; switching to two-dot would
  silently change what every Branch review shows.
