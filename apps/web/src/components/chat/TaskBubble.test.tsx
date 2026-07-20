import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TaskItem } from "@/stores/taskStore";
import { getTaskAggregateStatus, TaskBubble } from "./TaskBubble";

function task(status: TaskItem["status"]): Pick<TaskItem, "status"> {
  return { status };
}

function item(id: string, status: TaskItem["status"], content: string): TaskItem {
  return {
    id,
    content,
    status,
    group: "Tasks",
  };
}

describe("getTaskAggregateStatus", () => {
  it("returns null for empty parent-task lists", () => {
    expect(getTaskAggregateStatus([])).toBeNull();
  });

  it("is active when any parent task is in progress", () => {
    expect(getTaskAggregateStatus([task("pending"), task("in_progress")])).toBe("active");
  });

  it("is completed when all parent tasks are completed", () => {
    expect(getTaskAggregateStatus([task("completed"), task("completed")])).toBe("completed");
  });

  it("is completed when all parent tasks are cancelled", () => {
    expect(getTaskAggregateStatus([task("cancelled"), task("cancelled")])).toBe("completed");
  });

  it("is completed when parent tasks are completed plus cancelled", () => {
    expect(getTaskAggregateStatus([task("completed"), task("cancelled")])).toBe("completed");
  });

  it("is pending when all parent tasks are pending", () => {
    expect(getTaskAggregateStatus([task("pending"), task("pending")])).toBe("pending");
  });

  it("is mixed when settled and pending parent tasks coexist", () => {
    expect(getTaskAggregateStatus([task("completed"), task("pending")])).toBe("mixed");
  });

  it("renders aggregate progress as a static ring, not a spinner", () => {
    render(
      <TaskBubble
        tasks={[
          item("one", "completed", "Finish one"),
          item("two", "in_progress", "Finish two"),
          item("three", "pending", "Finish three"),
        ]}
      />,
    );

    const ring = screen.getByTestId("task-progress-circle");
    expect(ring).toBeInTheDocument();
    expect(ring.getAttribute("class")).not.toContain("animate-spin");
    expect(screen.getByRole("button", { name: "1 of 3 tasks settled" })).toHaveTextContent("1/3 steps");
  });

  it("opens on pointer hover using the shared collision-aware popover", () => {
    render(
      <TaskBubble
        tasks={[
          item("one", "completed", "Finish one"),
          item("two", "pending", "Finish two"),
        ]}
      />,
    );

    fireEvent.pointerEnter(screen.getByTestId("task-bubble"));

    const panel = screen.getByTestId("task-bubble-expanded");
    expect(panel).toHaveClass("w-[min(40rem,calc(100vw-2rem))]");
    expect(panel).toHaveClass("max-h-(--available-height)");
    expect(panel.parentElement).toHaveAttribute("data-side", "top");
  });

  it("bounds the expanded list with a scrollable padded viewport", () => {
    render(
      <TaskBubble
        tasks={Array.from({ length: 12 }, (_, index) =>
          item(`task-${index}`, index === 0 ? "in_progress" : "pending", `Task ${index + 1}`),
        )}
      />,
    );

    fireEvent.click(screen.getByTestId("task-bubble"));

    const viewport = screen
      .getByTestId("task-bubble-expanded")
      .querySelector('[data-slot="scroll-area-viewport"]');

    expect(viewport).toHaveClass("overflow-x-hidden", "overflow-y-auto", "scroll-py-2");
    expect(viewport).toHaveAttribute("aria-label", "Task list");
    expect(viewport).toHaveAttribute("tabindex", "0");
  });

  it("opens on keyboard focus and Escape closes it", () => {
    render(
      <TaskBubble tasks={[item("one", "in_progress", "Finish one")]} />,
    );

    const bubble = screen.getByTestId("task-bubble");
    fireEvent.focus(bubble);
    expect(screen.getByTestId("task-bubble-expanded")).toBeInTheDocument();

    fireEvent.keyDown(bubble, { key: "Escape" });
    expect(screen.queryByTestId("task-bubble-expanded")).not.toBeInTheDocument();
  });

  it("keeps click as a touch-compatible open and close fallback", () => {
    render(
      <TaskBubble tasks={[item("one", "pending", "Finish one")]} />,
    );

    const bubble = screen.getByTestId("task-bubble");
    fireEvent.pointerEnter(bubble, { pointerType: "touch" });
    fireEvent.click(bubble);
    expect(screen.getByTestId("task-bubble-expanded")).toBeInTheDocument();

    fireEvent.pointerEnter(bubble, { pointerType: "touch" });
    fireEvent.click(bubble);
    expect(screen.queryByTestId("task-bubble-expanded")).not.toBeInTheDocument();
  });

  it("renders semantic task rows with accessible statuses", () => {
    render(
      <TaskBubble tasks={[
        item("one", "completed", "Finish one"),
        item("two", "pending", "Finish two"),
      ]} />,
    );

    fireEvent.click(screen.getByTestId("task-bubble"));
    const list = screen.getByRole("list", { name: "Tasks" });
    expect(list).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText(/Completed:/)).toHaveClass("sr-only");
    expect(screen.getByText(/Pending:/)).toHaveClass("sr-only");
  });

  it("renders live file, addition, and deletion facts beside step progress", () => {
    render(
      <TaskBubble
        tasks={[item("one", "completed", "Finish one")]}
        fileEffects={{
          revision: 3,
          fileCount: 20,
          additions: 1211,
          deletions: 195,
          effects: [],
        }}
      />,
    );
    const bubble = screen.getByTestId("task-bubble");
    expect(bubble).toHaveTextContent("1/1 steps");
    expect(bubble).toHaveTextContent("20 files changed");
    expect(bubble).toHaveTextContent("+1211");
    expect(bubble).toHaveTextContent("−195");
  });

  it("uses singular file copy and omits zero line facts", () => {
    render(
      <TaskBubble
        tasks={[item("one", "in_progress", "Finish one")]}
        fileEffects={{ revision: 1, fileCount: 1, additions: 0, deletions: 0, effects: [] }}
      />,
    );
    expect(screen.getByTestId("task-bubble")).toHaveTextContent("1 file changed");
    expect(screen.getByTestId("task-bubble")).not.toHaveTextContent("+0");
  });
});
