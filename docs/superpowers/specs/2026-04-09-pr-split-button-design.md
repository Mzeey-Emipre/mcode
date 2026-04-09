# PR Split Button — Design Spec

**Date:** 2026-04-09
**Status:** Draft

## Problem

The chat header currently shows either "Create PR" or "View PR #N" depending on whether a PR exists. When a PR is closed or merged the button disappears and there is no way to create a replacement PR without checking the project tree. Users also cannot see the PR state at a glance from the header.

## Solution

Replace the two separate PR buttons with a single split button that is always present on feature branches. The left side is the primary action; the right chevron opens a dropdown for secondary actions. Text colour communicates PR state without a redundant status dot.

## States

`pr_status` values in the store are uppercase (`"OPEN"`, `"MERGED"`, `"CLOSED"`). `PrSplitButton` normalises the incoming `state` string with `.toLowerCase()` at the entry point and branches on `"open"`, `"merged"`, `"closed"` throughout.

| PR state | Left label | Text colour | Chevron |
|---|---|---|---|
| No PR, commits ahead | `Create PR` (unchanged) | muted | not rendered |
| No PR, no commits ahead | `Create PR` (disabled, unchanged) | muted | not rendered |
| `open` | `View PR #42` | `#3fb950` green | **not rendered** — left click opens URL |
| `merged` | `PR #42 merged` | `#a371f7` purple | rendered; click opens dropdown |
| `closed` | `PR #42 closed` | `#f85149` red | rendered; click opens dropdown |

**Left button click** always opens the PR URL in the external browser via `desktopBridge.openExternalUrl`.

**Dropdown contents** (merged and closed only):
1. View on GitHub ↗ — opens PR URL in browser
2. Divider
3. Create new PR — calls `onCreatePr`

## Visual Design

- Primary side: always-on subtle neutral background (`bg-muted/10` Tailwind token, ~`rgba(255,255,255,0.07)`) so it reads as a button at all times.
- GitHub icon on the left of the label in all states.
- Text colour is the sole state signal — no dot.
- Chevron side: lighter muted colour, separated by a 1px inner divider (`border-l border-border/20`).
- Whole split group uses `rounded` (Tailwind 4px token) — consistent with the `rounded-md` used for the surrounding pill but intentionally tighter for the button itself. If the visual review shows misalignment, align to `rounded-md`.

## Component Architecture

All changes are in `apps/web/src/components/chat/`.

### New component: `PrSplitButton`

File: `apps/web/src/components/chat/PrSplitButton.tsx`

**Props:**
```ts
interface PrSplitButtonProps {
  /** Null when no PR exists for this branch. */
  pr: { number: number; url: string; state: "OPEN" | "MERGED" | "CLOSED" | string } | null;
  /** Null while the initial poll is in flight. */
  hasCommitsAhead: boolean | null;
  /** Called when the user wants to open CreatePrDialog. */
  onCreatePr: () => void;
  /** Called with the PR URL when the user wants to open it in the browser. */
  onOpenPr: (url: string) => void;
}
```

**Responsibilities:**
- Renders "Create PR" button when `pr` is null. Disabled when `hasCommitsAhead` is false or null.
- Renders split button when `pr` is present.
- Normalises `pr.state` to lowercase at the top of the render function.
- Owns dropdown open/close state internally (`useState<boolean>`).
- Click-outside closes dropdown via `useRef<HTMLDivElement>` + `mousedown` listener (same pattern as `BaseBranchSelect` in `CreatePrDialog`).
- Chevron button is **not rendered** when `pr.state` (normalised) is `"open"`.
- Dropdown is rendered only when `pr.state` is `"merged"` or `"closed"`.

### Updated: `HeaderActions`

- Removes the existing `{pr && ...}` / `{!pr && ...}` branches.
- Continues to own `const [createPrOpen, setCreatePrOpen] = useState(false)`.
- Continues to render `<CreatePrDialog open={createPrOpen} ...>`.
- The `shouldPollPr` guard (`thread.branch !== "main" && thread.branch !== "master"`) stays in `HeaderActions` — `PrSplitButton` is only mounted when `shouldPollPr` is true.
- Renders `<PrSplitButton pr={pr} hasCommitsAhead={hasCommitsAhead} onCreatePr={() => setCreatePrOpen(true)} onOpenPr={handleOpenPr} />` in place of the removed branches.

### Unchanged

- `workspaceStore` — `pr_number`, `pr_status`, `prUrlsByThreadId` already in place.
- `useBranchPr` — polling continues unchanged.
- `CreatePrDialog` — reused as-is.

## Tests

File: `apps/web/src/components/chat/PrSplitButton.test.tsx`

| Scenario | Assertion |
|---|---|
| PR open | Renders "View PR #42" in green; left click calls `onOpenPr` with the URL |
| PR open — chevron absent | Chevron button is **not** in the DOM |
| PR merged | Renders "PR #42 merged" in purple; chevron present |
| Chevron click — merged | Dropdown opens with "View on GitHub" and "Create new PR" |
| "Create new PR" clicked | Calls `onCreatePr`; dropdown closes |
| PR closed | Renders "PR #42 closed" in red; chevron present; same dropdown |
| No PR, commits ahead | Renders "Create PR" enabled; click calls `onCreatePr` |
| No PR, no commits ahead | Renders "Create PR" disabled |
| No PR, commits null (loading) | Renders "Create PR" disabled |
| Click outside open dropdown | Dropdown closes |
| `pr.state` uppercase ("OPEN") | Normalised correctly — renders green "View PR #N" |

No E2E tests required — purely presentational state machine with no async behaviour.

## Out of Scope

- Showing commit count or diff stat in the dropdown.
- Multiple PR support per branch.
- Inline PR status refresh button.
