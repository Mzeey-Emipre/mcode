import { WorkspaceEnvironmentServiceError } from "./workspace-environment-errors.js";

/** Thread facts required to admit a Project Action start. */
export interface ProjectActionStartThread {
  readonly id: string;
  readonly workspace_id: string;
  readonly deleted_at: string | null;
  readonly user_completed_at: string | null;
}

interface ActionLifecycle {
  closing: boolean;
  teardownCount: number;
  readonly starts: Set<Promise<void>>;
}

/** Coordinates Project Action start admission with Thread and Workspace teardown. */
export class ProjectActionAdmissionGate {
  private readonly threadLifecycles = new Map<string, ActionLifecycle>();
  private readonly workspaceLifecycles = new Map<string, ActionLifecycle>();
  private disposed = false;

  /** Rejects a start when its Thread or Workspace no longer accepts Action work. */
  assertThreadCanStart(thread: ProjectActionStartThread, current: ProjectActionStartThread | null): void {
    if (this.isUnavailable(thread, current)) throw unavailableThreadError();
  }

  /** Reserves a start that teardown must wait to settle. */
  reserveStart(threadId: string, workspaceId: string): () => void {
    if (this.isAdmissionClosed(threadId, workspaceId)) throw unavailableThreadError();
    const threadLifecycle = this.threadLifecycleFor(threadId);
    const workspaceLifecycle = this.workspaceLifecycleFor(workspaceId);
    let resolve!: () => void;
    const settled = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
    threadLifecycle.starts.add(settled);
    workspaceLifecycle.starts.add(settled);
    return () => this.releaseStart(threadId, workspaceId, threadLifecycle, workspaceLifecycle, settled, resolve);
  }

  /** Blocks Thread starts and waits for starts that already passed admission. */
  async beginThreadTeardown(threadId: string): Promise<() => void> {
    const lifecycle = this.threadLifecycleFor(threadId);
    lifecycle.teardownCount += 1;
    lifecycle.closing = true;
    await Promise.all(lifecycle.starts);
    return this.releaseThreadTeardown(threadId, lifecycle);
  }

  /** Blocks Workspace starts and waits for starts that already passed admission. */
  async beginWorkspaceTeardown(workspaceId: string): Promise<() => void> {
    const lifecycle = this.workspaceLifecycleFor(workspaceId);
    lifecycle.teardownCount += 1;
    lifecycle.closing = true;
    await Promise.all(lifecycle.starts);
    return this.releaseWorkspaceTeardown(workspaceId, lifecycle);
  }

  /** Reopens Thread admission when no teardown barrier remains. */
  reopenThread(threadId: string): void {
    const lifecycle = this.threadLifecycleFor(threadId);
    if (!this.disposed && lifecycle.teardownCount === 0) lifecycle.closing = false;
    this.removeThreadLifecycleIfIdle(threadId, lifecycle);
  }

  /** Permanently blocks new Project Action starts. */
  beginDisposal(): void {
    this.disposed = true;
  }

  /** Returns Thread identifiers that have an admission lifecycle. */
  threadIds(): string[] {
    return [...this.threadLifecycles.keys()];
  }

  /** Clears admission state after service disposal completes. */
  clear(): void {
    this.threadLifecycles.clear();
    this.workspaceLifecycles.clear();
  }

  private isUnavailable(thread: ProjectActionStartThread, current: ProjectActionStartThread | null): boolean {
    return this.isAdmissionClosed(thread.id, thread.workspace_id)
      || !current
      || current.deleted_at !== null
      || current.user_completed_at !== null;
  }

  private isAdmissionClosed(threadId: string, workspaceId: string): boolean {
    return this.disposed
      || this.threadLifecycles.get(threadId)?.closing === true
      || this.workspaceLifecycles.get(workspaceId)?.closing === true;
  }

  private releaseStart(
    threadId: string,
    workspaceId: string,
    threadLifecycle: ActionLifecycle,
    workspaceLifecycle: ActionLifecycle,
    settled: Promise<void>,
    resolve: () => void,
  ): void {
    threadLifecycle.starts.delete(settled);
    workspaceLifecycle.starts.delete(settled);
    resolve();
    this.removeThreadLifecycleIfIdle(threadId, threadLifecycle);
    this.removeWorkspaceLifecycleIfIdle(workspaceId, workspaceLifecycle);
  }

  private releaseThreadTeardown(threadId: string, lifecycle: ActionLifecycle): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      lifecycle.teardownCount -= 1;
      if (!this.disposed && lifecycle.teardownCount === 0) lifecycle.closing = false;
      this.removeThreadLifecycleIfIdle(threadId, lifecycle);
    };
  }

  private releaseWorkspaceTeardown(workspaceId: string, lifecycle: ActionLifecycle): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      lifecycle.teardownCount -= 1;
      if (!this.disposed && lifecycle.teardownCount === 0) lifecycle.closing = false;
      this.removeWorkspaceLifecycleIfIdle(workspaceId, lifecycle);
    };
  }

  private threadLifecycleFor(threadId: string): ActionLifecycle {
    const existing = this.threadLifecycles.get(threadId);
    if (existing) return existing;
    const lifecycle: ActionLifecycle = { closing: false, teardownCount: 0, starts: new Set() };
    this.threadLifecycles.set(threadId, lifecycle);
    return lifecycle;
  }

  private workspaceLifecycleFor(workspaceId: string): ActionLifecycle {
    const existing = this.workspaceLifecycles.get(workspaceId);
    if (existing) return existing;
    const lifecycle: ActionLifecycle = { closing: false, teardownCount: 0, starts: new Set() };
    this.workspaceLifecycles.set(workspaceId, lifecycle);
    return lifecycle;
  }

  private removeThreadLifecycleIfIdle(threadId: string, lifecycle: ActionLifecycle): void {
    if (!lifecycle.closing && lifecycle.starts.size === 0) this.threadLifecycles.delete(threadId);
  }

  private removeWorkspaceLifecycleIfIdle(workspaceId: string, lifecycle: ActionLifecycle): void {
    if (!lifecycle.closing && lifecycle.starts.size === 0) this.workspaceLifecycles.delete(workspaceId);
  }
}

function unavailableThreadError(): WorkspaceEnvironmentServiceError {
  return new WorkspaceEnvironmentServiceError(
    "WORKSPACE_ENVIRONMENT_NOT_FOUND",
    "Thread is unavailable for Project Actions",
  );
}
