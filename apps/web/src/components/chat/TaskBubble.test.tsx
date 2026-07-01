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

  it("expands upward from the centered bubble anchor", () => {
    render(
      <TaskBubble
        tasks={[
          item("one", "completed", "Finish one"),
          item("two", "pending", "Finish two"),
        ]}
      />,
    );

    fireEvent.click(screen.getByTestId("task-bubble"));

    expect(screen.getByTestId("task-bubble-expanded")).toHaveClass("bottom-full", "left-1/2", "-translate-x-1/2");
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
  });
});
