# PR Split Button Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the separate "Create PR" / "View PR" buttons in the chat header with a single split button that shows PR state via text colour and exposes secondary actions in a dropdown.

**Architecture:** A new `PrSplitButton` component owns all PR-related UI and dropdown state. `HeaderActions` delegates rendering to it and continues to own `createPrOpen` state and `CreatePrDialog`. No store changes are needed — `workspaceStore.recordPrCreated`, `pr_number`, `pr_status`, and `prUrlsByThreadId` are already in place from the previous session.

**Tech Stack:** React 18, TypeScript, Tailwind CSS 4, Vitest + @testing-library/react, lucide-react (GitHub icon), existing `Button` component from `@/components/ui/button`.

**Spec:** `docs/superpowers/specs/2026-04-09-pr-split-button-design.md`

---

## Chunk 1: PrSplitButton component + tests

### Files

| Action | Path |
|---|---|
| Create | `apps/web/src/components/chat/PrSplitButton.tsx` |
| Create | `apps/web/src/components/chat/PrSplitButton.test.tsx` |
| Modify | `apps/web/src/components/chat/HeaderActions.tsx` |

---

### Task 1: Write all failing tests for PrSplitButton

**File:** `apps/web/src/components/chat/PrSplitButton.test.tsx`

- [ ] **Step 1: Create the test file**

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PrSplitButton } from "./PrSplitButton";

const noop = () => {};

describe("PrSplitButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── No PR ──────────────────────────────────────────────────────────────────

  it("renders Create PR enabled when pr is null and hasCommitsAhead is true", () => {
    render(<PrSplitButton pr={null} hasCommitsAhead={true} onCreatePr={noop} onOpenPr={noop} />);
    expect(screen.getByRole("button", { name: /create pr/i })).not.toBeDisabled();
  });

  it("renders Create PR disabled when pr is null and hasCommitsAhead is false", () => {
    render(<PrSplitButton pr={null} hasCommitsAhead={false} onCreatePr={noop} onOpenPr={noop} />);
    expect(screen.getByRole("button", { name: /create pr/i })).toBeDisabled();
  });

  it("renders Create PR disabled when pr is null and hasCommitsAhead is null (loading)", () => {
    render(<PrSplitButton pr={null} hasCommitsAhead={null} onCreatePr={noop} onOpenPr={noop} />);
    expect(screen.getByRole("button", { name: /create pr/i })).toBeDisabled();
  });

  it("calls onCreatePr when Create PR is clicked", () => {
    const onCreatePr = vi.fn();
    render(<PrSplitButton pr={null} hasCommitsAhead={true} onCreatePr={onCreatePr} onOpenPr={noop} />);
    fireEvent.click(screen.getByRole("button", { name: /create pr/i }));
    expect(onCreatePr).toHaveBeenCalledTimes(1);
  });

  // ── PR open ────────────────────────────────────────────────────────────────

  const openPr = { number: 42, url: "https://github.com/o/r/pull/42", state: "OPEN" };

  it("renders View PR #42 when pr state is OPEN (uppercase — normalised)", () => {
    render(<PrSplitButton pr={openPr} hasCommitsAhead={true} onCreatePr={noop} onOpenPr={noop} />);
    expect(screen.getByText(/view pr #42/i)).toBeInTheDocument();
  });

  it("applies green colour class when pr state is open", () => {
    render(<PrSplitButton pr={openPr} hasCommitsAhead={true} onCreatePr={noop} onOpenPr={noop} />);
    // The primary button wraps the label — find it via the label text's parent button
    const btn = screen.getByText(/view pr #42/i).closest("button");
    expect(btn?.className).toContain("text-[#3fb950]");
  });

  it("does not render chevron button when pr state is open", () => {
    render(<PrSplitButton pr={openPr} hasCommitsAhead={true} onCreatePr={noop} onOpenPr={noop} />);
    expect(screen.queryByRole("button", { name: /open pr menu/i })).not.toBeInTheDocument();
  });

  it("calls onOpenPr with the url when View PR is clicked", () => {
    const onOpenPr = vi.fn();
    render(<PrSplitButton pr={openPr} hasCommitsAhead={true} onCreatePr={noop} onOpenPr={onOpenPr} />);
    fireEvent.click(screen.getByText(/view pr #42/i));
    expect(onOpenPr).toHaveBeenCalledWith("https://github.com/o/r/pull/42");
  });

  // ── PR merged ──────────────────────────────────────────────────────────────

  const mergedPr = { number: 42, url: "https://github.com/o/r/pull/42", state: "MERGED" };

  it("renders PR #42 merged when pr state is MERGED", () => {
    render(<PrSplitButton pr={mergedPr} hasCommitsAhead={true} onCreatePr={noop} onOpenPr={noop} />);
    expect(screen.getByText(/pr #42 merged/i)).toBeInTheDocument();
  });

  it("applies purple colour class when pr state is merged", () => {
    render(<PrSplitButton pr={mergedPr} hasCommitsAhead={true} onCreatePr={noop} onOpenPr={noop} />);
    const btn = screen.getByText(/pr #42 merged/i).closest("button");
    expect(btn?.className).toContain("text-[#a371f7]");
  });

  it("renders chevron button when pr state is merged", () => {
    render(<PrSplitButton pr={mergedPr} hasCommitsAhead={true} onCreatePr={noop} onOpenPr={noop} />);
    expect(screen.getByRole("button", { name: /open pr menu/i })).toBeInTheDocument();
  });

  it("opens dropdown when chevron is clicked on merged PR", () => {
    render(<PrSplitButton pr={mergedPr} hasCommitsAhead={true} onCreatePr={noop} onOpenPr={noop} />);
    fireEvent.click(screen.getByRole("button", { name: /open pr menu/i }));
    expect(screen.getByText(/view on github/i)).toBeInTheDocument();
    expect(screen.getByText(/create new pr/i)).toBeInTheDocument();
  });

  it("calls onCreatePr and closes dropdown when Create new PR is clicked", () => {
    const onCreatePr = vi.fn();
    render(<PrSplitButton pr={mergedPr} hasCommitsAhead={true} onCreatePr={onCreatePr} onOpenPr={noop} />);
    fireEvent.click(screen.getByRole("button", { name: /open pr menu/i }));
    fireEvent.click(screen.getByText(/create new pr/i));
    expect(onCreatePr).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/view on github/i)).not.toBeInTheDocument();
  });

  // ── PR closed ──────────────────────────────────────────────────────────────

  const closedPr = { number: 42, url: "https://github.com/o/r/pull/42", state: "CLOSED" };

  it("renders PR #42 closed and applies red colour class when pr state is CLOSED", () => {
    render(<PrSplitButton pr={closedPr} hasCommitsAhead={true} onCreatePr={noop} onOpenPr={noop} />);
    expect(screen.getByText(/pr #42 closed/i)).toBeInTheDocument();
    const btn = screen.getByText(/pr #42 closed/i).closest("button");
    expect(btn?.className).toContain("text-[#f85149]");
  });

  it("renders chevron and dropdown for closed PR", () => {
    render(<PrSplitButton pr={closedPr} hasCommitsAhead={true} onCreatePr={noop} onOpenPr={noop} />);
    fireEvent.click(screen.getByRole("button", { name: /open pr menu/i }));
    expect(screen.getByText(/view on github/i)).toBeInTheDocument();
    expect(screen.getByText(/create new pr/i)).toBeInTheDocument();
  });

  it("closes dropdown when clicking outside", () => {
    render(
      <div>
        <PrSplitButton pr={mergedPr} hasCommitsAhead={true} onCreatePr={noop} onOpenPr={noop} />
        <div data-testid="outside">outside</div>
      </div>
    );
    fireEvent.click(screen.getByRole("button", { name: /open pr menu/i }));
    expect(screen.getByText(/view on github/i)).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(screen.queryByText(/view on github/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests — confirm they all fail**

```bash
cd apps/web && bun run test src/components/chat/PrSplitButton.test.tsx
```

Expected: all 18 tests fail with "Cannot find module './PrSplitButton'"

---

### Task 2: Implement PrSplitButton

**File:** `apps/web/src/components/chat/PrSplitButton.tsx`

- [ ] **Step 3: Create the component**

```tsx
import { useState, useRef, useEffect } from "react";
import { Github, ChevronDown, GitPullRequest } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Props for {@link PrSplitButton}. */
interface PrSplitButtonProps {
  /** Null when no PR exists for this branch. */
  pr: { number: number; url: string; state: "OPEN" | "MERGED" | "CLOSED" | string } | null;
  /** Null while the initial commits-ahead poll is in flight. */
  hasCommitsAhead: boolean | null;
  /** Called when the user wants to open CreatePrDialog. */
  onCreatePr: () => void;
  /** Called with the PR URL when the user wants to open it in the browser. */
  onOpenPr: (url: string) => void;
}

/**
 * Split button for PR actions in the chat header.
 * When no PR exists, renders a "Create PR" button (disabled until commits are detected).
 * When a PR exists, renders a primary action button coloured by state plus an optional
 * chevron that opens a dropdown for secondary actions (merged/closed only).
 */
export function PrSplitButton({ pr, hasCommitsAhead, onCreatePr, onOpenPr }: PrSplitButtonProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close dropdown on click outside
  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [dropdownOpen]);

  // No PR — show Create PR button
  if (!pr) {
    return (
      <Button
        variant="ghost"
        size="xs"
        className="gap-1 text-xs text-foreground/70 hover:text-foreground hover:bg-muted/40 h-6"
        onClick={onCreatePr}
        disabled={!hasCommitsAhead}
        title={!hasCommitsAhead ? "No commits ahead of base branch" : undefined}
      >
        <GitPullRequest size={12} />
        <span>Create PR</span>
      </Button>
    );
  }

  const state = pr.state.toLowerCase();
  const stateColour =
    state === "merged" ? "text-[#a371f7] hover:text-[#bc8fff]" :
    state === "closed" ? "text-[#f85149] hover:text-[#ff6b63]" :
    "text-[#3fb950] hover:text-[#5ee375]";

  const label =
    state === "merged" ? `PR #${pr.number} merged` :
    state === "closed" ? `PR #${pr.number} closed` :
    `View PR #${pr.number}`;

  const showChevron = state === "merged" || state === "closed";

  return (
    <div ref={containerRef} className="relative inline-flex">
      <div className="inline-flex rounded overflow-hidden">
        {/* Primary action */}
        <button
          className={`inline-flex items-center gap-1.5 px-2 h-6 text-xs bg-muted/10 hover:bg-muted/20 transition-colors ${stateColour}`}
          onClick={() => onOpenPr(pr.url)}
        >
          <Github size={12} className="opacity-80 flex-shrink-0" />
          <span>{label}</span>
        </button>

        {/* Chevron — only for merged/closed */}
        {showChevron && (
          <button
            aria-label="Open PR menu"
            className={`inline-flex items-center px-1.5 h-6 text-xs bg-muted/10 hover:bg-muted/20 border-l border-border/20 transition-colors ${stateColour}`}
            onClick={() => setDropdownOpen((o) => !o)}
          >
            <ChevronDown size={11} className={`transition-transform ${dropdownOpen ? "rotate-180" : ""}`} />
          </button>
        )}
      </div>

      {/* Dropdown */}
      {dropdownOpen && (
        <div className="absolute top-full left-0 mt-1 z-50 min-w-[170px] rounded-md border border-border/50 bg-popover shadow-md py-1">
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-foreground/70 hover:text-foreground hover:bg-muted/40 flex items-center gap-2"
            onClick={() => { onOpenPr(pr.url); setDropdownOpen(false); }}
          >
            <Github size={11} />
            View on GitHub ↗
          </button>
          <div className="my-1 border-t border-border/30" />
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-foreground/70 hover:text-foreground hover:bg-muted/40 flex items-center gap-2"
            onClick={() => { onCreatePr(); setDropdownOpen(false); }}
          >
            <GitPullRequest size={11} />
            Create new PR
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests — confirm all 18 pass**

```bash
cd apps/web && bun run test src/components/chat/PrSplitButton.test.tsx
```

Expected: 18/18 pass

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/chat/PrSplitButton.tsx \
        apps/web/src/components/chat/PrSplitButton.test.tsx
git commit -m "feat: add PrSplitButton component with state-coloured label and dropdown"
```

---

### Task 3: Wire PrSplitButton into HeaderActions

**File:** `apps/web/src/components/chat/HeaderActions.tsx`

- [ ] **Step 6: Update `handleOpenPr` to accept and use the URL argument**

`PrSplitButton` calls `onOpenPr(url)` passing the URL explicitly. Update `handleOpenPr` to accept it:

Replace:
```tsx
  const handleOpenPr = () => {
    if (pr?.url) {
      try {
        const parsed = new URL(pr.url);
        if (parsed.protocol === "https:") {
          window.desktopBridge?.openExternalUrl(pr.url);
        }
      } catch {
        // Invalid URL, ignore
      }
    }
  };
```

With:
```tsx
  const handleOpenPr = (url: string) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:") {
        window.desktopBridge?.openExternalUrl(url);
      }
    } catch {
      // Invalid URL, ignore
    }
  };
```

- [ ] **Step 7: Replace the two existing PR branches with PrSplitButton**

In the JSX, replace the block:

```tsx
          {pr && (
            <>
              <Button
                variant="ghost"
                size="xs"
                onClick={handleOpenPr}
                className="gap-1 text-xs text-foreground/70 hover:text-foreground hover:bg-muted/40 h-6"
                title={`PR #${pr.number} – ${pr.state}`}
              >
                <Github size={12} />
                <span>View PR #{pr.number}</span>
              </Button>
              <div className="w-px h-4 bg-border/30" />
            </>
          )}
          {!pr && shouldPollPr && (
            <Button
              variant="ghost"
              size="xs"
              className="gap-1 text-xs text-foreground/70 hover:text-foreground hover:bg-muted/40 h-6"
              onClick={() => setCreatePrOpen(true)}
              disabled={!hasCommitsAhead}
              title={hasCommitsAhead === false ? "No commits ahead of base branch" : undefined}
            >
              <GitPullRequest size={12} />
              <span>Create PR</span>
            </Button>
          )}
```

With:

```tsx
          {shouldPollPr && (
            <PrSplitButton
              pr={pr}
              hasCommitsAhead={hasCommitsAhead}
              onCreatePr={() => setCreatePrOpen(true)}
              onOpenPr={handleOpenPr}
            />
          )}
```

> **Note:** The `shouldPollPr` guard is essential. It prevents `PrSplitButton` from rendering on `main`/`master` branches.

- [ ] **Step 8: Update imports**

Add:
```tsx
import { PrSplitButton } from "./PrSplitButton";
```

Remove `Github` and `GitPullRequest` from the lucide-react import line (they are no longer used in `HeaderActions`).

**Do NOT remove `Button`** — it is still used by the Terminal and Diff toggle buttons in the same file.

- [ ] **Step 9: Check `HeaderActions.test.tsx` for broken assertions**

```bash
cd apps/web && bun run test src/components/chat/HeaderActions.test.tsx 2>&1 | head -40
```

If any test references the old "View PR" or "Create PR" button markup directly, update those assertions to match the new `PrSplitButton` output. The component renders the same text content so most assertions should still pass.

- [ ] **Step 10: Run typecheck**

```bash
cd apps/web && bunx tsc --noEmit 2>&1 | grep -v node_modules
```

Expected: no new errors

- [ ] **Step 11: Run the full frontend test suite**

```bash
cd apps/web && bun run test
```

Expected: all tests pass including `PrSplitButton.test.tsx` and `HeaderActions.test.tsx`

- [ ] **Step 12: Commit**

```bash
git add apps/web/src/components/chat/HeaderActions.tsx
git commit -m "refactor: replace separate PR buttons with PrSplitButton in HeaderActions"
```

---

### Task 4: Push and verify CI

- [ ] **Step 13: Push**

```bash
git push
```

- [ ] **Step 14: Watch CI**

```bash
gh pr checks 213 --watch
```

Expected: Build Check ✓, Lint Frontend ✓, Test Frontend ✓, Test Server ✓

If any check fails:
```bash
gh run view --log-failed
```
