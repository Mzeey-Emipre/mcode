import { beforeEach, describe, expect, it } from "vitest";
import { useTaskStore, type TaskItem } from "./taskStore";

const THREAD = "thread-task-bubble";

function task(id: string, status: TaskItem["status"], group = "Tasks"): TaskItem {
  return { id, content: id, status, group };
}

describe("task bubble lifecycle", () => {
  beforeEach(() => {
    useTaskStore.setState({
      tasksByThread: {},
      taskBubbleByThread: {},
      pendingTaskBubbleReplacementByThread: {},
    });
  });

  it("shows parent-agent tasks and excludes sub-agent groups", () => {
    useTaskStore.getState().setTasks(THREAD, [
      task("parent", "pending"),
      task("child", "pending", "Child agent"),
    ]);

    expect(useTaskStore.getState().taskBubbleByThread[THREAD]).toEqual([
      task("parent", "pending"),
    ]);
  });

  it("clears settled parent tasks on new send", () => {
    useTaskStore.getState().setTaskGroup(THREAD, "Tasks", [
      task("done", "completed"),
      task("dropped", "cancelled"),
    ]);

    useTaskStore.getState().prepareTaskBubbleForNewTurn(THREAD);

    expect(useTaskStore.getState().taskBubbleByThread[THREAD]).toBeUndefined();
  });

  it("keeps unsettled old tasks until first parent-task update replaces them", () => {
    useTaskStore.getState().setTaskGroup(THREAD, "Tasks", [task("old", "pending")]);

    useTaskStore.getState().prepareTaskBubbleForNewTurn(THREAD);
    expect(useTaskStore.getState().taskBubbleByThread[THREAD]).toEqual([task("old", "pending")]);

    useTaskStore.getState().setTaskGroup(THREAD, "Tasks", [task("new", "in_progress")]);

    expect(useTaskStore.getState().taskBubbleByThread[THREAD]).toEqual([
      task("new", "in_progress"),
    ]);
    expect(useTaskStore.getState().pendingTaskBubbleReplacementByThread[THREAD]).toBeUndefined();
  });

  it("clears unsettled old tasks when the new turn ends without parent-task updates", () => {
    useTaskStore.getState().setTaskGroup(THREAD, "Tasks", [task("old", "pending")]);

    useTaskStore.getState().prepareTaskBubbleForNewTurn(THREAD);
    useTaskStore.getState().clearTaskBubbleIfAwaitingReplacement(THREAD);

    expect(useTaskStore.getState().taskBubbleByThread[THREAD]).toBeUndefined();
  });
});
