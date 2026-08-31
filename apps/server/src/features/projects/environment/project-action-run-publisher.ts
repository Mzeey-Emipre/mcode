import type { WorkspaceEnvironmentActionRun } from "@mcode/contracts";
import type { ProjectActionRunRepo } from "./persistence/project-action-run-repo.js";

/** Durable Project Action update delivered to connected Thread views. */
export interface ProjectActionRunUpdate {
  readonly threadId: string;
  readonly actionId: string;
  readonly runId: string;
  readonly run: WorkspaceEnvironmentActionRun;
}

/** Persists and publishes retained Project Action run changes. */
export class ProjectActionRunPublisher {
  private readonly listeners = new Set<(update: ProjectActionRunUpdate) => void>();

  constructor(private readonly runs: Pick<ProjectActionRunRepo, "replace">) {}

  /** Adds a listener for retained Project Action run changes. */
  onUpdate(listener: (update: ProjectActionRunUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Replaces one retained run and publishes the durable value. */
  persistAndPublish(run: WorkspaceEnvironmentActionRun): WorkspaceEnvironmentActionRun {
    const retained = this.runs.replace(run);
    this.publish(retained);
    return retained;
  }

  /** Publishes a durable retained run without another persistence write. */
  publish(run: WorkspaceEnvironmentActionRun): void {
    const update: ProjectActionRunUpdate = {
      threadId: run.threadId,
      actionId: run.actionId,
      runId: run.runId,
      run,
    };
    for (const listener of this.listeners) listener(update);
  }
}
