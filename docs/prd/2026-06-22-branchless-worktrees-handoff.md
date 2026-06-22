# Branchless worktrees handoff

## Purpose

This handoff gives implementation agents the map for the branchless worktrees
epic. The full product scope lives in GitHub issues; this file records where to
start, which decisions are settled, and which skills to load.

## Primary references

- Epic: https://github.com/Mzeey-Empire/mcode/issues/799
- Slice 1: https://github.com/Mzeey-Empire/mcode/issues/800
- Slice 2: https://github.com/Mzeey-Empire/mcode/issues/801
- Slice 3: https://github.com/Mzeey-Empire/mcode/issues/802
- ADR: `docs/adr/0015-branchless-worktrees-for-new-isolated-threads.md`
- Glossary: `CONTEXT.md`

## Issue graph

```text
#799 branchless worktrees epic
└── #800 create and use branchless new worktrees
    ├── #801 create pull requests from branchless worktrees
    └── #802 attach existing branchless worktrees
```

`#801` and `#802` are blocked by `#800`.

## Settled language

- Use **Branchless worktree** in product and domain docs.
- Use detached `HEAD` only when talking about git implementation details.
- Do not treat `HEAD` as a branch name.
- Thread checkout state is the source of truth for named branch versus
  branchless state.

## Implementation notes

- Keep slices vertical. Do not land a schema-only or UI-only partial that leaves
  branchless worktrees unusable.
- Slice 1 must let a user create a branchless worktree, run a thread, inspect
  Review, read Overview, and create a branch in place.
- Review compares saved base branch to `HEAD` for branchless worktrees. Review
  picker changes are inspection state and must not mutate the saved base branch.
- Branchless threads are not PR-able until Create branch succeeds.
- Settings should tolerate old `worktree.naming.*` values, but the user-facing
  settings and composer naming controls should go away.

## Suggested skills

- `implement` for issue execution.
- `tdd` if changing checkout-state contracts, git service behavior, or PR gates.
- `design-dna` or `impeccable` for Overview, composer, or Create PR UI changes.
- `security-review` for mutating git RPCs or any path/ref input boundary.
- `verify-live` before claiming any runtime behavior is complete.
