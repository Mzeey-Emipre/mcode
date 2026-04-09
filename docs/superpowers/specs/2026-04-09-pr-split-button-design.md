# PR Split Button — Design Spec

**Date:** 2026-04-09
**Status:** Approved

## Problem

The chat header currently shows either "Create PR" or "View PR #N" depending on whether a PR exists. When a PR is closed or merged the button disappears and there is no way to create a replacement PR without knowing to check the project tree. Users also cannot see the PR state at a glance from the header.

## Solution

Replace the two separate PR buttons with a single split button that is always present on feature branches. The left side is the primary action; the right chevron opens a dropdown for secondary actions. Text colour communicates PR state without a redundant status dot.

## States

| PR state | Left label | Text colour | Chevron dropdown |
|---|---|---|---|
| No PR, commits ahead | `Create PR` | muted (unchanged) | none |
| No PR, no commits ahead | `Create PR` (disabled) | muted (unchanged) | none |
| Open | `View PR #42` | `#3fb950` green | none (click = open URL) |
| Merged | `PR #42 merged` | `#a371f7` purple | View on GitHub + Create new PR |
| Closed | `PR #42 closed` | `#f85149` red | View on GitHub + Create new PR |

- Left button click always opens the PR URL in the external browser.
- Chevron on an open PR has no dropdown — it opens the URL too.
- Chevron on merged/closed drops a menu with two items: **View on GitHub** and **Create new PR**.
- "Create new PR" opens the existing `CreatePrDialog`.

## Visual Design

- Primary side: always-on subtle neutral background (`rgba(255,255,255,0.07)`) so it reads as a button at all times.
- GitHub icon on the left of the label in all states.
- Text colour is the sole state signal — no dot.
- Chevron side: lighter muted colour, separated by a 1px inner divider.
- Whole split group uses `border-radius: 4px`, consistent with the rest of the header bar.

## Component Architecture

All changes are contained in `apps/web/src/components/chat/`.

### New component: `PrSplitButton`

Extract into `apps/web/src/components/chat/PrSplitButton.tsx`.

**Props:**
```ts
interface PrSplitButtonProps {
  pr: { number: number; url: string; state: string } | null;
  hasCommitsAhead: boolean | null;
  onCreatePr: () => void;
  onOpenPr: (url: string) => void;
}
```

**Responsibilities:**
- Renders "Create PR" button when `pr` is null (delegates `onCreatePr`).
- Renders split button when `pr` is present.
- Owns dropdown open/close state internally.
- Click-outside closes dropdown via `useRef` + `mousedown` listener.
- Dropdown rendered only when `pr.state` is `merged` or `closed`.

### Updated: `HeaderActions`

- Removes the two existing `{pr && ...}` / `{!pr && ...}` branches.
- Renders `<PrSplitButton>` in their place, passing down `pr`, `hasCommitsAhead`, `onCreatePr`, `onOpenPr`.
- No other changes to `HeaderActions`.

### Unchanged

- `workspaceStore` — `pr_number`, `pr_status`, `prUrlsByThreadId` already in place.
- `useBranchPr` — polling continues unchanged.
- `CreatePrDialog` — reused as-is.

## Tests

File: `apps/web/src/components/chat/PrSplitButton.test.tsx`

| Scenario | Assertion |
|---|---|
| PR open | Renders "View PR #42", text colour green, chevron present, left click calls `onOpenPr` |
| PR merged | Renders "PR #42 merged", text colour purple, chevron click opens dropdown |
| Dropdown merged | Contains "View on GitHub" and "Create new PR" |
| "Create new PR" clicked | Calls `onCreatePr` |
| PR closed | Renders "PR #42 closed", text colour red, same dropdown |
| No PR, commits ahead | Renders "Create PR" enabled, click calls `onCreatePr` |
| No PR, no commits ahead | Renders "Create PR" disabled |
| Click outside dropdown | Dropdown closes |

No E2E tests required — purely presentational state machine with no async behaviour.

## Out of Scope

- Showing commit count or diff stat in the dropdown.
- Multiple PR support per branch.
- Inline PR status refresh button.
