import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TaskItem } from "@/stores/taskStore";
import { TaskPanelHeader } from "./TaskPanelHeader";

const TASKS: readonly TaskItem[] = [
  { id: "done", content: "Done", status: "completed", group: "Tasks" },
  { id: "pending", content: "Pending", status: "pending", group: "Tasks" },
];

describe("TaskPanelHeader", () => {
  it("exposes the progress label to assistive technology", () => {
    render(<TaskPanelHeader tasks={TASKS} />);

    const progressLabel = screen.getByText("1 of 2 tasks completed");
    expect(progressLabel).toHaveClass("sr-only");
    expect(progressLabel.nextElementSibling).toHaveAttribute("aria-hidden", "true");
    expect(progressLabel.nextElementSibling).toHaveTextContent("1/2");
  });
});
