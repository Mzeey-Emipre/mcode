import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TaskItem } from "@/stores/taskStore";
import { TaskGroup } from "./TaskGroup";

const TASK: TaskItem = {
  id: "task-1",
  content: "Track child changes",
  status: "in_progress",
  group: "Tasks",
};

describe("TaskGroup", () => {
  it.each([true, false])("contains task rows in a list when hideHeader is %s", (hideHeader) => {
    render(<TaskGroup name="Tasks" tasks={[TASK]} hideHeader={hideHeader} />);

    const taskRow = screen.getByRole("listitem");
    expect(taskRow.parentElement).toHaveRole("list");
  });
});
