import { inject, injectable } from "tsyringe";
import { logger } from "@mcode/shared";
import { NarrativeStore } from "../conversation/narrative/narrative-store.js";
import { TaskRepo, type StoredTask } from "../orchestration/persistence/task-repo.js";

/** Persists provider task-tool state for reconnect hydration. */
@injectable()
export class TaskPersistenceService {
  constructor(
    @inject(TaskRepo) private readonly tasks: TaskRepo,
    @inject(NarrativeStore) private readonly narrative: NarrativeStore,
  ) {}

  /** Persist task state from one tool-use event after narrative attribution. */
  onToolUse(
    threadId: string,
    event: { toolName: string; toolInput: Record<string, unknown>; parentToolCallId?: string },
  ): void {
    const group = event.parentToolCallId ? this.groupFor(threadId, event.parentToolCallId) : "Tasks";
    if (event.toolName === "TodoWrite") {
      this.persistTodoWrite(threadId, event.toolInput, group);
      return;
    }
    if (event.toolName === "TaskUpdate") {
      this.applyTaskUpdate(threadId, event.toolInput, group);
      return;
    }
    if (event.toolName === "update_plan") this.persistPlanTasks(threadId, event.toolInput, group);
  }

  /** Persist one TaskCreate after its result supplies the stable harness identity. */
  onToolResult(threadId: string, toolCallId: string, output: string, isError: boolean): void {
    if (isError) return;
    const buffered = this.narrative.getBufferedToolCalls(threadId)
      .find((tool) => tool.toolCallId === toolCallId && tool.toolName === "TaskCreate");
    if (!buffered) return;
    const id = this.parseHarnessId(output);
    const input = buffered._rawToolInput ?? {};
    const content = this.taskContent(input);
    if (!id || !content) return;
    const group = buffered.parentToolCallId ? this.groupFor(threadId, buffered.parentToolCallId) : "Tasks";
    const activeForm = this.nonEmpty(input.activeForm);
    this.tryPersist("TaskCreate task", threadId, () => this.tasks.appendTask(threadId, {
      id,
      content,
      status: "pending",
      ...(activeForm ? { activeForm } : {}),
      group,
    }));
  }

  private persistTodoWrite(threadId: string, input: Record<string, unknown>, group: string): void {
    if (!Array.isArray(input.todos)) return;
    const todos = input.todos.flatMap((value): StoredTask[] => {
      if (!this.isRecord(value) || !this.nonEmpty(value.content)) return [];
      return [{ content: String(value.content), status: this.status(value.status), group }];
    });
    if (todos.length > 0) this.tryPersist("TodoWrite tasks", threadId, () => this.tasks.upsertGroup(threadId, group, todos));
  }

  private persistPlanTasks(threadId: string, input: Record<string, unknown>, group: string): void {
    const values = Array.isArray(input.plan)
      ? input.plan
      : Array.isArray(input.tasks)
        ? input.tasks
        : Array.isArray(input.todos)
          ? input.todos
          : [];
    const tasks = values.flatMap((value): StoredTask[] => {
      const item: Record<string, unknown> = this.isRecord(value) ? value : { step: value };
      const content = this.nonEmpty(item.step) ?? this.nonEmpty(item.content)
        ?? this.nonEmpty(item.title) ?? this.nonEmpty(item.description);
      return content ? [{ content, status: this.status(item.status), group }] : [];
    });
    if (tasks.length > 0) this.tryPersist("update_plan tasks", threadId, () => this.tasks.upsertGroup(threadId, group, tasks));
  }

  private applyTaskUpdate(threadId: string, input: Record<string, unknown>, group: string): void {
    const id = input.taskId == null ? "" : String(input.taskId);
    if (!id) return;
    this.tryPersist("TaskUpdate", threadId, () => {
      if (input.status === "deleted") {
        this.tasks.removeTask(threadId, id, group);
        return;
      }
      const patch: Partial<Pick<StoredTask, "status" | "content" | "activeForm">> = {};
      if (input.status !== undefined) patch.status = this.status(input.status);
      const content = this.nonEmpty(input.subject);
      const activeForm = this.nonEmpty(input.activeForm);
      if (content) patch.content = content;
      if (activeForm) patch.activeForm = activeForm;
      if (Object.keys(patch).length > 0) this.tasks.updateTask(threadId, id, patch, group);
    });
  }

  private groupFor(threadId: string, parentToolCallId: string): string {
    const calls = this.narrative.getBufferedToolCalls(threadId);
    let current: string | undefined = parentToolCallId;
    while (current) {
      const call = calls.find((item) => item.toolCallId === current);
      if (!call) break;
      if (call.toolName === "Agent") {
        const label = this.nonEmpty(call._rawToolInput?.description) ?? this.nonEmpty(call._rawToolInput?.prompt);
        return label ? label.slice(0, 80) : "Sub-agent";
      }
      current = call.parentToolCallId;
    }
    return "Sub-agent";
  }

  private status(value: unknown): StoredTask["status"] {
    switch (value) {
      case "inProgress":
      case "in-progress":
        return "in_progress";
      case "canceled":
        return "cancelled";
      case "pending":
      case "in_progress":
      case "completed":
      case "cancelled":
        return value;
      default:
        return "pending";
    }
  }

  private taskContent(input: Record<string, unknown>): string | null {
    const subject = this.nonEmpty(input.subject) ?? this.nonEmpty(input.title) ?? this.nonEmpty(input.content);
    const description = this.nonEmpty(input.description);
    if (!subject) return description;
    return description ? `${subject} - ${description}` : subject;
  }

  private parseHarnessId(output: string): string | null {
    return /#(\d+)/.exec(output)?.[1] ?? null;
  }

  private nonEmpty(value: unknown): string | null {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object";
  }

  private tryPersist(label: string, threadId: string, persist: () => void): void {
    try {
      persist();
    } catch (error) {
      logger.warn(`${label} not persisted`, {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
