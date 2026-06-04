# Plan-mode Adaptive Dock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Scope-tab split pane reflow adaptively so plan mode never leaves the top of the panel empty, and make the Implement action a glowing, always-visible primary.

**Architecture:** The Scope tab already renders `ScopeSplitPane` (plan on top, tasks docket on the bottom, draggable divider). Today it always renders the plan region with `flex-1`, so when no plan exists `PlanPanel` returns `null` and the top goes blank while tasks pin to 35%. We make `ScopeSplitPane` read `planStore` and branch into three layouts: plan+tasks (the existing split), plan-only (plan fills), and no-plan (tasks or the empty docket fill). We then promote `PlanChrome`'s Implement button to a glowing primary, and cap the plan-questions wizard to the composer width. No backend, contract, or store-shape changes.

**Tech Stack:** React 19, Zustand, Tailwind 4, shadcn/ui (`Button`, `Tooltip`), Vitest + @testing-library/react, plain CSS keyframes in `apps/web/src/index.css`.

---

## Background: what already exists (read before starting)

- `apps/web/src/components/panels/ScopeSplitPane.tsx` — the split pane. Receives `threadId` and `parentTasks: readonly TaskItem[]` (already filtered to `group === "Tasks"` by `RightPanel`). Renders `<PlanPanel>` (top), a `role="separator"` drag handle, and `<TaskPanelHeader> + <TaskPanel>` (bottom).
- `apps/web/src/components/panels/plan/PlanPanel.tsx` — renders `PlanChrome` + `PlanDocument`, or `PlanSkeleton` when generating, or `null` when there is no plan and not generating. Viewport has `data-testid="plan-panel-viewport"`.
- `apps/web/src/components/panels/plan/PlanChrome.tsx` — sticky header: version prev/next (`v{n}`), `Revise` → `Feedback (n)`, and `Implement` (currently `variant="ghost"`).
- `apps/web/src/components/panels/plan/PlanSkeleton.tsx` — the generating skeleton.
- `apps/web/src/stores/planStore.ts` — `plansByThread`, `activeVersionByThread`, `generatingThreads`. No changes needed.
- `apps/web/src/components/tasks/TaskPanel.tsx` — renders the task list, or a centered empty state (`∅` glyph + “Nothing on the docket”) when there are no `group === "Tasks"` tasks. Reads `useWorkspaceStore.activeThreadId` + `useTaskStore.tasksByThread`.
- `apps/web/src/components/tasks/TaskPanelHeader.tsx` — `TaskPanelHeader({ tasks })` progress header.
- `apps/web/src/index.css` — keyframes + `@media (prefers-reduced-motion: reduce)` blocks. A reduced-motion block listing wizard animations lives around lines 353-365.
- `apps/web/src/components/chat/PlanQuestionWizard.tsx` — the plan-questions wizard. Root `role="form"` element currently uses `mx-3 mb-1.5 ...`. The composer content wrapper is `mx-auto w-full max-w-4xl` (`Composer.tsx:2122`).

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `apps/web/src/components/panels/ScopeSplitPane.tsx` | Adaptive layout decision across plan/task presence | Modify |
| `apps/web/src/components/panels/ScopeSplitPane.test.tsx` | Unit tests for the three layout branches | Create |
| `apps/web/src/components/panels/plan/PlanSkeleton.tsx` | Add a stable test hook | Modify (1 attr) |
| `apps/web/src/index.css` | `plan-implement-glow` keyframe + reduced-motion entry | Modify |
| `apps/web/src/components/panels/plan/PlanChrome.tsx` | Glowing primary Implement button + version-history dropdown | Modify |
| `apps/web/src/components/panels/plan/PlanChrome.test.tsx` | Assert Implement glow + version dropdown lists revisions | Create |
| `apps/web/src/components/panels/plan/PlanPanel.tsx` | "Viewing older revision" banner + back-to-latest | Modify |
| `apps/web/src/lib/format-relative.ts` | `formatRelative(iso)` → "6m ago" helper | Create |
| `apps/web/src/components/chat/PlanQuestionWizard.tsx` | Cap wizard width to composer max-width | Modify (1 className) |

---

## Task 1: Make ScopeSplitPane reflow adaptively

**Files:**
- Modify: `apps/web/src/components/panels/ScopeSplitPane.tsx`
- Modify: `apps/web/src/components/panels/plan/PlanSkeleton.tsx` (add `data-testid="plan-skeleton"`)
- Test: `apps/web/src/components/panels/ScopeSplitPane.test.tsx`

- [ ] **Step 1: Add a stable test hook to PlanSkeleton**

Open `apps/web/src/components/panels/plan/PlanSkeleton.tsx` and add `data-testid="plan-skeleton"` to its outermost returned element. Example (match the file's existing root element/attrs, only add the attribute):

```tsx
// before:  <div className="...">
// after:
<div data-testid="plan-skeleton" className="...">
```

- [ ] **Step 2: Write the failing tests**

Create `apps/web/src/components/panels/ScopeSplitPane.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanRecord } from "@mcode/contracts";
import type { TaskItem } from "@/stores/taskStore";
import { usePlanStore } from "@/stores/planStore";
import { useTaskStore } from "@/stores/taskStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { createMockThread, mockTransport } from "@/__tests__/mocks/transport";
import { ScopeSplitPane } from "./ScopeSplitPane";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

const THREAD = "thread-scope";

const makePlan = (version: number): PlanRecord => ({
  id: `plan-${version}`,
  threadId: THREAD,
  messageId: `00000000-0000-4000-8000-00000000000${version}`,
  version,
  title: `Version ${version} Plan`,
  contentMd: "## Step\n\nDo the thing.",
  sectionsJson: [{ id: `s${version}`, title: "Step", level: 2 }],
  changeSummary: null,
  status: "draft",
  createdAt: `2026-06-03T00:00:0${version}.000Z`,
});

const makeTask = (id: string): TaskItem => ({
  id,
  content: `Task ${id}`,
  status: "pending",
  group: "Tasks",
});

beforeEach(() => {
  usePlanStore.setState({ plansByThread: {}, activeVersionByThread: {}, generatingThreads: new Set() });
  useTaskStore.setState({ tasksByThread: {} });
  useWorkspaceStore.setState({
    activeThreadId: THREAD,
    threads: [createMockThread({ id: THREAD, interaction_mode: "plan" })],
  });
  vi.clearAllMocks();
});

describe("ScopeSplitPane adaptive dock", () => {
  it("shows the resizable split when a plan and tasks both exist", () => {
    usePlanStore.setState({ plansByThread: { [THREAD]: [makePlan(1)] } });
    useTaskStore.setState({ tasksByThread: { [THREAD]: [makeTask("a")] } });
    render(<ScopeSplitPane threadId={THREAD} parentTasks={[makeTask("a")]} />);
    expect(screen.getByTestId("plan-panel-viewport")).toBeInTheDocument();
    expect(
      screen.getByRole("separator", { name: /resize plan and tasks/i }),
    ).toBeInTheDocument();
  });

  it("fills the pane with tasks (no plan region, no divider) when there is no plan", () => {
    useTaskStore.setState({ tasksByThread: { [THREAD]: [makeTask("a")] } });
    render(<ScopeSplitPane threadId={THREAD} parentTasks={[makeTask("a")]} />);
    expect(screen.queryByTestId("plan-panel-viewport")).not.toBeInTheDocument();
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
  });

  it("shows only the empty docket (no plan region, no divider) when no plan and no tasks", () => {
    render(<ScopeSplitPane threadId={THREAD} parentTasks={[]} />);
    expect(screen.getByText(/nothing on the docket/i)).toBeInTheDocument();
    expect(screen.queryByTestId("plan-panel-viewport")).not.toBeInTheDocument();
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
  });

  it("fills the pane with the plan (no divider) when a plan exists but there are no tasks", () => {
    usePlanStore.setState({ plansByThread: { [THREAD]: [makePlan(1)] } });
    render(<ScopeSplitPane threadId={THREAD} parentTasks={[]} />);
    expect(screen.getByTestId("plan-panel-viewport")).toBeInTheDocument();
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
  });

  it("shows the skeleton while generating with no tasks, and no divider", () => {
    usePlanStore.setState({ generatingThreads: new Set([THREAD]) });
    render(<ScopeSplitPane threadId={THREAD} parentTasks={[]} />);
    expect(screen.getByTestId("plan-skeleton")).toBeInTheDocument();
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd apps/web && bunx vitest run src/components/panels/ScopeSplitPane.test.tsx`
Expected: FAIL — the "no plan" cases still render `plan-panel-viewport`/`separator` because the current component always renders them.

- [ ] **Step 4: Implement the adaptive layout**

Replace the contents of `apps/web/src/components/panels/ScopeSplitPane.tsx` with:

```tsx
import { useCallback, useRef, useState } from "react";
import type { PlanRecord } from "@mcode/contracts";
import type { TaskItem } from "@/stores/taskStore";
import { usePlanStore } from "@/stores/planStore";
import { PlanPanel } from "./plan";
import { TaskPanelHeader } from "@/components/tasks/TaskPanelHeader";
import { TaskPanel } from "@/components/tasks/TaskPanel";

interface ScopeSplitPaneProps {
  threadId: string;
  parentTasks: readonly TaskItem[];
}

/** Minimum height for the task section in pixels. */
const TASKS_MIN_H = 80;
/** Minimum height for the plan section in pixels. */
const PLAN_MIN_H = 120;
/** Stable empty array so the planStore selector keeps a stable reference. */
const EMPTY_PLANS: readonly PlanRecord[] = [];

/**
 * Adaptive vertical dock for the Scope tab. The layout reflows so the top is
 * never left empty:
 *  - plan + tasks: resizable split (plan top, tasks bottom, draggable divider).
 *  - plan, no tasks: the plan fills the pane (no divider).
 *  - no plan (incl. empty): the tasks docket — or its empty state — fills the
 *    pane (no plan region, no divider).
 * "Generating" counts as having a plan so the skeleton owns the top.
 */
export function ScopeSplitPane({ threadId, parentTasks }: ScopeSplitPaneProps) {
  const plans = usePlanStore((s) => s.plansByThread[threadId] ?? EMPTY_PLANS);
  const isGenerating = usePlanStore((s) => s.generatingThreads.has(threadId));
  const hasPlan = plans.length > 0 || isGenerating;
  const hasTasks = parentTasks.length > 0;

  const containerRef = useRef<HTMLDivElement>(null);
  const [taskPct, setTaskPct] = useState(35);
  const draggingRef = useRef(false);

  const onDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      const container = containerRef.current;
      if (!container) return;

      const startY = e.clientY;
      const containerRect = container.getBoundingClientRect();
      const containerH = containerRect.height;
      const startTaskH = containerH * (taskPct / 100);

      const onMove = (ev: MouseEvent) => {
        if (!draggingRef.current) return;
        const deltaY = ev.clientY - startY;
        const newTaskH = Math.max(
          TASKS_MIN_H,
          Math.min(containerH - PLAN_MIN_H, startTaskH - deltaY),
        );
        setTaskPct((newTaskH / containerH) * 100);
      };

      const onUp = () => {
        draggingRef.current = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
    },
    [taskPct],
  );

  const onDoubleClick = useCallback(() => {
    setTaskPct(35);
  }, []);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    const step = 5;
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setTaskPct((p) => Math.min(90, p + step));
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setTaskPct((p) => Math.max(10, p - step));
    }
  }, []);

  // No plan: the docket (or its empty state) fills the pane. The header only
  // shows when there are tasks so the empty state reads as a single centered
  // glyph rather than "0 tasks" chrome over a void.
  if (!hasPlan) {
    return (
      <div className="flex flex-1 flex-col min-h-0">
        {hasTasks && <TaskPanelHeader tasks={parentTasks} />}
        <TaskPanel />
      </div>
    );
  }

  // Plan but no tasks: the plan fills the pane, no divider.
  if (!hasTasks) {
    return (
      <div className="flex flex-1 flex-col min-h-0">
        <div className="flex min-h-0 flex-1 basis-0 flex-col overflow-hidden">
          <PlanPanel threadId={threadId} />
        </div>
      </div>
    );
  }

  // Plan + tasks: the resizable split.
  return (
    <div ref={containerRef} className="flex flex-1 flex-col min-h-0">
      <div className="flex min-h-0 flex-1 basis-0 flex-col overflow-hidden">
        <PlanPanel threadId={threadId} />
      </div>

      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize plan and tasks sections"
        tabIndex={0}
        onMouseDown={onDragStart}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
        className="group flex h-[9px] flex-shrink-0 cursor-row-resize items-center justify-center border-y border-border/50 bg-background transition-colors hover:bg-accent/50"
      >
        <div className="h-[2px] w-8 rounded-full bg-muted-foreground/20 transition-colors group-hover:bg-muted-foreground/40" />
      </div>

      <div
        className="flex flex-col flex-shrink-0 overflow-hidden"
        style={{ height: `${taskPct}%`, minHeight: TASKS_MIN_H }}
      >
        <TaskPanelHeader tasks={parentTasks} />
        <TaskPanel />
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/web && bunx vitest run src/components/panels/ScopeSplitPane.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/panels/ScopeSplitPane.tsx apps/web/src/components/panels/ScopeSplitPane.test.tsx apps/web/src/components/panels/plan/PlanSkeleton.tsx
git commit -m "fix(plan): reflow scope dock so the plan tab is never empty on top"
```

---

## Task 2: Glowing, always-visible Implement button

**Files:**
- Modify: `apps/web/src/index.css`
- Modify: `apps/web/src/components/panels/plan/PlanChrome.tsx`
- Test: `apps/web/src/components/panels/plan/PlanChrome.test.tsx`

- [ ] **Step 1: Add the glow keyframe to index.css**

In `apps/web/src/index.css`, immediately after the `.glow-primary { ... }` rule (around line 369), add:

```css
/* Implement is the primary plan action; a slow amber glow keeps it findable
   without shouting. Disabled under reduced-motion below. */
@keyframes plan-implement-glow {
  0%, 100% {
    box-shadow: 0 0 0 0 oklch(0.72 0.17 75 / 0), 0 0 12px 0 oklch(0.72 0.17 75 / 0.22);
  }
  50% {
    box-shadow: 0 0 0 3px oklch(0.72 0.17 75 / 0.10), 0 0 20px 2px oklch(0.72 0.17 75 / 0.38);
  }
}
.animate-plan-implement-glow {
  animation: plan-implement-glow 2.6s ease-in-out infinite;
}
```

- [ ] **Step 2: Disable the glow under reduced motion**

In the existing reduced-motion block (the one listing `.animate-wizard-*`, around line 353-365), add `.animate-plan-implement-glow` to the selector list so it reads:

```css
@media (prefers-reduced-motion: reduce) {
  .animate-wizard-hairline,
  .animate-wizard-header,
  .animate-wizard-tile,
  .animate-wizard-nav,
  .animate-wizard-question-forward,
  .animate-wizard-question-back,
  .animate-wizard-legend,
  .animate-wizard-accept-flash,
  .animate-wizard-marker-echo,
  .animate-plan-implement-glow {
    animation: none;
  }
}
```

- [ ] **Step 3: Write the failing test**

Create `apps/web/src/components/panels/plan/PlanChrome.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanRecord } from "@mcode/contracts";
import { usePlanStore } from "@/stores/planStore";
import { PlanChrome } from "./PlanChrome";

const plan: PlanRecord = {
  id: "plan-1",
  threadId: "t1",
  messageId: "00000000-0000-4000-8000-000000000001",
  version: 1,
  title: "A Plan",
  contentMd: "## Step\n\nDo it.",
  sectionsJson: [{ id: "s1", title: "Step", level: 2 }],
  changeSummary: null,
  status: "draft",
  createdAt: "2026-06-03T00:00:01.000Z",
};

beforeEach(() => {
  usePlanStore.setState({ plansByThread: {}, activeVersionByThread: {}, generatingThreads: new Set() });
  vi.clearAllMocks();
});

describe("PlanChrome Implement button", () => {
  it("always renders Implement as a glowing primary action", () => {
    render(
      <PlanChrome
        plan={plan}
        allVersions={[plan]}
        threadId="t1"
        onRevise={() => {}}
        onImplement={() => {}}
        commentCount={0}
      />,
    );
    const implement = screen.getByRole("button", { name: /implement/i });
    expect(implement).toBeInTheDocument();
    expect(implement.className).toContain("animate-plan-implement-glow");
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd apps/web && bunx vitest run src/components/panels/plan/PlanChrome.test.tsx`
Expected: FAIL — the Implement button does not yet have the `animate-plan-implement-glow` class.

- [ ] **Step 5: Promote the Implement button in PlanChrome**

In `apps/web/src/components/panels/plan/PlanChrome.tsx`, change the Implement `Button` (the one wrapped in the second `Tooltip`) from:

```tsx
<Button
  type="button"
  variant="ghost"
  size="xs"
  onClick={onImplement}
  className="font-mono text-[10px] uppercase tracking-[0.16em] text-primary hover:text-primary"
>
  Implement
</Button>
```

to:

```tsx
<Button
  type="button"
  variant="default"
  size="xs"
  onClick={onImplement}
  className="animate-plan-implement-glow font-mono text-[10px] uppercase tracking-[0.16em]"
>
  Implement
</Button>
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd apps/web && bunx vitest run src/components/panels/plan/PlanChrome.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/index.css apps/web/src/components/panels/plan/PlanChrome.tsx apps/web/src/components/panels/plan/PlanChrome.test.tsx
git commit -m "feat(plan): make Implement a glowing always-visible primary action"
```

---

## Task 3: Cap the plan-questions wizard to composer width

**Files:**
- Modify: `apps/web/src/components/chat/PlanQuestionWizard.tsx`

This is a one-class styling change; it is verified visually in Task 4 rather than with a brittle store-seeding unit test.

- [ ] **Step 1: Cap the wizard container width**

In `apps/web/src/components/chat/PlanQuestionWizard.tsx`, the root `role="form"` element's `className` currently starts with `"mx-3 mb-1.5"`. Change that first argument so the wizard centers and matches the composer's `max-w-4xl`:

```tsx
// before:
className={cn(
  "mx-3 mb-1.5",
  "rounded-xl border border-border bg-card",
  "px-5 pt-4 pb-3",
  "animate-wizard-float-rise",
)}

// after:
className={cn(
  "mx-auto mb-1.5 w-full max-w-4xl",
  "rounded-xl border border-border bg-card",
  "px-5 pt-4 pb-3",
  "animate-wizard-float-rise",
)}
```

- [ ] **Step 2: Typecheck + lint the change**

Run: `node scripts/agent/verify-fast.mjs`
Expected: PASS (typecheck + lint).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/chat/PlanQuestionWizard.tsx
git commit -m "style(plan): cap plan-questions wizard to composer width"
```

---

## Task 4: Version-history dropdown control

Replace `PlanChrome`'s bare prev/next chevrons with a **revision-history dropdown** (the proven Google-Docs / Linear pattern). Versions are sequential revisions; the control must surface each revision's number, relative time, status, and change summary, and show a "viewing an older revision" banner when you step back. **Visual + interaction source of truth: `docs/prototypes/plan-mode/b-adaptive-dock.html` (the `renderDropdown` function and the `vc-*` styles), version-UI "A · Dropdown".**

**Files:**
- Create: `apps/web/src/lib/format-relative.ts`
- Modify: `apps/web/src/components/panels/plan/PlanChrome.tsx`
- Modify: `apps/web/src/components/panels/plan/PlanPanel.tsx`
- Test: `apps/web/src/components/panels/plan/PlanChrome.test.tsx` (extend Task 2's file)

- [ ] **Step 1: Create the relative-time helper**

Create `apps/web/src/lib/format-relative.ts`:

```ts
/** Format an ISO timestamp as a short relative label, e.g. "just now", "6m ago", "3h ago", "2d ago". */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  const sec = Math.max(0, Math.round((now - then) / 1000));
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}
```

- [ ] **Step 2: Write the failing test**

Append to `apps/web/src/components/panels/plan/PlanChrome.test.tsx` (inside the existing `describe`), and add `fireEvent`, `waitFor` to the `@testing-library/react` import:

```tsx
it("lists every revision with its change summary and selects an older one", async () => {
  const v1: PlanRecord = { ...plan, id: "p1", version: 1, status: "superseded", changeSummary: "First pass", createdAt: "2026-06-04T11:40:00.000Z" };
  const v2: PlanRecord = { ...plan, id: "p2", version: 2, status: "superseded", changeSummary: "Optimistic move", createdAt: "2026-06-04T11:54:00.000Z" };
  const v3: PlanRecord = { ...plan, id: "p3", version: 3, status: "draft", changeSummary: "Hardened rollback", createdAt: "2026-06-04T12:00:00.000Z" };
  usePlanStore.setState({ plansByThread: { t1: [v1, v2, v3] } });

  render(
    <PlanChrome plan={v3} allVersions={[v1, v2, v3]} threadId="t1" onRevise={() => {}} onImplement={() => {}} commentCount={0} />,
  );

  fireEvent.click(screen.getByRole("button", { name: /v3/i }));
  expect(await screen.findByText(/optimistic move/i)).toBeInTheDocument();
  expect(screen.getByText(/first pass/i)).toBeInTheDocument();

  fireEvent.click(screen.getByText(/first pass/i));
  await waitFor(() => expect(usePlanStore.getState().activeVersionByThread.t1).toBe(1));
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/web && bunx vitest run src/components/panels/plan/PlanChrome.test.tsx`
Expected: FAIL — no revision dropdown exists yet (the chevrons expose no change summaries).

- [ ] **Step 4: Replace the chevron nav with the dropdown in PlanChrome**

In `apps/web/src/components/panels/plan/PlanChrome.tsx`:

1. Replace the lucide import `import { ChevronLeft, ChevronRight } from "lucide-react";` with `import { ChevronDown } from "lucide-react";`.
2. Add imports: `import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";` and `import { formatRelative } from "@/lib/format-relative";`.
3. Replace the entire "Version nav" `<div ...>...</div>` block (the bordered group containing the two chevron `Tooltip`s and the `v{plan.version}` span) with:

```tsx
<Popover>
  <PopoverTrigger
    render={
      <Button
        type="button"
        variant="outline"
        size="xs"
        className="shrink-0 gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em]"
        aria-label={`Revision history: v${plan.version} of ${maxVersion}`}
      >
        v{plan.version}
        <span className="tracking-normal text-muted-foreground/70 normal-case">
          {formatRelative(plan.createdAt)}
        </span>
        <ChevronDown size={12} aria-hidden />
      </Button>
    }
  />
  <PopoverContent align="start" className="w-72 p-1">
    <div className="px-2 py-1.5 font-mono text-[9px] uppercase tracking-[0.16em] text-muted-foreground/60">
      Revision history
    </div>
    {[...allVersions].reverse().map((p) => {
      const isLatest = p.version === maxVersion;
      const isActive = p.version === plan.version;
      return (
        <button
          key={p.id}
          type="button"
          onClick={() => setActiveVersion(threadId, isLatest ? null : p.version)}
          className={cn(
            "flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/50",
            isActive && "bg-accent/40",
          )}
        >
          <span className="flex items-center gap-2">
            <span className={cn("font-mono text-[11px]", isActive ? "text-primary" : "text-foreground")}>
              v{p.version}
            </span>
            <span className="font-mono text-[10px] text-muted-foreground/70">
              {formatRelative(p.createdAt)}
            </span>
            <span
              className={cn(
                "ml-auto rounded-full px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-[0.1em]",
                isLatest ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
              )}
            >
              {isLatest ? "latest" : p.status}
            </span>
          </span>
          {p.changeSummary && (
            <span className="text-[11px] leading-snug text-muted-foreground">{p.changeSummary}</span>
          )}
        </button>
      );
    })}
  </PopoverContent>
</Popover>
```

The `canPrev`/`canNext` consts and the two chevron tooltips are no longer used — remove them. `setActiveVersion`, `maxVersion`, `cn` are already in scope.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/web && bunx vitest run src/components/panels/plan/PlanChrome.test.tsx`
Expected: PASS (Task 2 glow test + this revision test).

- [ ] **Step 6: Add the "viewing older revision" banner in PlanPanel**

In `apps/web/src/components/panels/plan/PlanPanel.tsx`, the component already has `plans`, `activeVersion`, `activePlan`, and `usePlanStore`. Add a `setActiveVersion` accessor and a derived `viewingOld`, then render a banner above the chrome.

Add near the other store reads:

```tsx
const setActiveVersion = usePlanStore((s) => s.setActiveVersion);
const latestVersion = plans.length > 0 ? plans[plans.length - 1].version : 1;
const viewingOld = activeVersion !== null && activePlan !== null && activePlan.version !== latestVersion;
```

Then, inside the returned tree, immediately before `<PlanChrome ... />`, add:

```tsx
{viewingOld && activePlan && (
  <div className="flex min-w-0 flex-shrink-0 items-center gap-2 border-b border-border bg-primary/5 px-3 py-1.5 font-mono text-[10px] tracking-[0.14em] text-muted-foreground">
    <span className="min-w-0 truncate">
      Viewing v{activePlan.version} of {latestVersion} · read-only
    </span>
    <span className="min-w-0 flex-1" aria-hidden />
    <button
      type="button"
      onClick={() => setActiveVersion(threadId, null)}
      className="shrink-0 text-primary hover:underline"
    >
      Back to latest
    </button>
  </div>
)}
```

- [ ] **Step 7: Typecheck + lint**

Run: `node scripts/agent/verify-fast.mjs`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/lib/format-relative.ts apps/web/src/components/panels/plan/PlanChrome.tsx apps/web/src/components/panels/plan/PlanChrome.test.tsx apps/web/src/components/panels/plan/PlanPanel.tsx
git commit -m "feat(plan): replace version chevrons with a revision-history dropdown"
```

---

## Task 5: Verify (full gate + visual)

**Files:** none (verification only).

- [ ] **Step 1: Run the full verification gate**

Run: `bun run verify`
Expected: PASS (typecheck + lint + unit tests across every package).

- [ ] **Step 2: Visual verification in a live plan-mode session**

Start the app (`bun run dev`), open a thread, switch the composer to **Plan** mode, and drive a request that produces a plan. Confirm against `docs/prototypes/plan-mode/b-adaptive-dock.html`:
- Plan + tasks: plan on top, docket on the bottom, draggable divider between them.
- Plan, no tasks: the plan fills the Scope tab; no empty strip at the bottom.
- No plan, tasks present: the docket fills the tab from the top (no empty region above it).
- No plan, no tasks: a single centered “Nothing on the docket” state — no empty top.
- Generating: the skeleton owns the top.
- The Implement button is filled, glowing, and always visible in the plan chrome.
- The version control is a dropdown showing each revision's version, relative time, status, and change summary; selecting an older revision shows the read-only "Viewing v2 of 3 · Back to latest" banner.
- The plan-questions wizard is centered and no wider than the composer.

If Playwright MCP is unavailable, capture the same states with the documented Node + `playwright-core` fallback against a running dev server. Note in the PR if visual verification was manual.

- [ ] **Step 3: Final commit (only if Step 2 surfaced fixes)**

```bash
git add -A
git commit -m "fix(plan): adaptive dock visual polish from live verification"
```

---

## Self-Review

**Spec coverage**
- "Reflow adaptively across 5 states so the top is never empty" → Task 1 (three branches cover plan+tasks, plan-only, no-plan; generating folds into has-plan; empty folds into no-plan via `TaskPanel`'s own empty state). Tests assert no `plan-panel-viewport`/`separator` in the no-plan branches.
- "Glowing always-visible Implement + index.css keyframe + reduced-motion override" → Task 2.
- "Version system: revisions, not parallel options; proven dropdown pattern with when + what-changed; viewing-old banner" → Task 4 (replaces `PlanChrome` chevrons with a revision-history dropdown driven by `PlanRecord.version/createdAt/status/changeSummary`; `PlanPanel` banner + back-to-latest via `setActiveVersion(threadId, null)`).
- "Cap PlanQuestionWizard to composer max-width" → Task 3.
- "Keep section-annotation → revise feedback as-is" → untouched (`PlanPanel` feedback paths unchanged; only the version nav in `PlanChrome` changes).
- "bun run verify; visual + E2E per agent-workflow" → Task 5 (full gate + visual). Automated coverage is the RTL suites in Tasks 1, 2, and 4 (the repo tests this surface with RTL, not E2E; the layout and version-select logic are store-driven and fully covered by unit tests). Visual confirms the live result.

**Placeholder scan** — none. Every code step shows full code; the only "match existing" instruction is the single `data-testid` attribute add in Task 1 Step 1 and the className edits, both quoted in full.

**Type consistency** — `ScopeSplitPaneProps` (`threadId`, `parentTasks`) unchanged so `RightPanel.tsx:358` keeps compiling. `EMPTY_PLANS: readonly PlanRecord[]` matches the `planStore` selector type. `TaskItem` fields (`id`, `content`, `status`, `group`) match `taskStore.ts`. `PlanRecord` test fixtures match `packages/contracts/src/models/plan-output.ts` (`sectionsJson` uses `PlanSectionNav` = `{id,title,level}`). `PlanChrome` props match its current interface.

**Out of scope (noted, not built):** free-highlight canvas comments (existing section annotation kept), a "Derive tasks" affordance for the plan-only state (plan simply fills; tasks appear when the agent emits them), and renaming the Scope tab.
