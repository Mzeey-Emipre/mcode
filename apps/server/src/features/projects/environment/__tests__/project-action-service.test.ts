import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceEnvironmentActionRun } from "@mcode/contracts";
import {
  PreparedTerminalCommandStartError,
  type PreparedTerminalCommandSession,
} from "../../../terminal/backends/terminal-backend.js";
import { ProjectActionService } from "../project-action-service.js";

class Runs {
  private readonly values = new Map<string, WorkspaceEnvironmentActionRun>();
  get(threadId: string, actionId: string) { return this.values.get(`${threadId}\0${actionId}`) ?? null; }
  list(threadId: string) { return [...this.values.values()].filter((run) => run.threadId === threadId); }
  replace(run: WorkspaceEnvironmentActionRun) { this.values.set(`${run.threadId}\0${run.actionId}`, run); return run; }
  updateIfCurrent(run: WorkspaceEnvironmentActionRun) {
    const current = this.get(run.threadId, run.actionId);
    if (!current || current.runId !== run.runId) return false;
    this.replace(run);
    return true;
  }
  interruptRunning() { return []; }
}

function session(
  id: string,
  replay?: { readonly output?: string; readonly exitCode?: number | null },
  stopAction?: () => Promise<void>,
): PreparedTerminalCommandSession & { emit(data: string): void; exit(code: number | null): void } {
  const outputs = new Set<(data: Uint8Array) => void>();
  const exits = new Set<(exit: { exitCode: number | null }) => void>();
  return {
    terminalSessionId: id,
    snapshot: {
      platform: "windows",
      script: "bun run build",
      checkoutPath: "C:\\repo",
      terminal: { executable: "powershell.exe", arguments: ["-Command", "bun run build"] },
      environmentNames: ["PATH"],
    },
    onOutput(listener) {
      outputs.add(listener);
      if (replay?.output !== undefined) listener(new TextEncoder().encode(replay.output));
      return () => outputs.delete(listener);
    },
    onExit(listener) {
      exits.add(listener);
      if (replay?.exitCode !== undefined) listener({ exitCode: replay.exitCode });
      return () => exits.delete(listener);
    },
    async stop() {
      if (stopAction) return stopAction();
      for (const listener of exits) listener({ exitCode: null });
    },
    emit(data) { for (const listener of outputs) listener(new TextEncoder().encode(data)); },
    exit(exitCode) { for (const listener of exits) listener({ exitCode }); },
  };
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

describe("ProjectActionService", () => {
  it("excludes one slot, allows a second Action, preserves its immutable snapshot, and ignores stale output", async () => {
    const runs = new Runs();
    const first = session("terminal-1");
    const second = session("terminal-2");
    const sessions = [first, second];
    const service = new ProjectActionService(
      runs as never,
      { read: async () => ({ document: { version: "0.0.1", actions: [
        { id: "build", name: "Build", command: { default: "bun run build" } },
        { id: "test", name: "Test", command: { default: "bun test" } },
      ] } }) } as never,
      { findById: () => ({ id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: null }) } as never,
      { startPreparedCommand: async () => sessions.shift()! } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      (() => { let value = 0; return () => `run-${++value}`; })(),
    );

    const build = await service.start({ threadId: "thread-1", actionId: "build" });
    await expect(service.start({ threadId: "thread-1", actionId: "build" })).rejects.toMatchObject({
      code: "WORKSPACE_ENVIRONMENT_ACTION_RUNNING",
    });
    const test = await service.start({ threadId: "thread-1", actionId: "test" });
    expect(test.runId).not.toBe(build.runId);
    expect(build.snapshot.terminal?.arguments).toEqual(["-Command", "bun run build"]);

    first.emit("old output");
    first.exit(0);
    expect(runs.get("thread-1", "build")).toMatchObject({ status: "completed", revision: 2 });
    expect(runs.get("thread-1", "test")?.status).toBe("running");
  });

  it("reserves a slot while its environment document is still loading", async () => {
    const runs = new Runs();
    const environmentRead = deferred<{ readonly document: { readonly version: "0.0.1"; readonly actions: readonly [{ readonly id: "build"; readonly name: "Build"; readonly command: { readonly default: "bun run build" } }] } }>();
    const startPreparedCommand = vi.fn(async () => session("terminal-1"));
    const service = new ProjectActionService(
      runs as never,
      { read: vi.fn(() => environmentRead.promise) } as never,
      { findById: () => ({ id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: null }) } as never,
      { startPreparedCommand } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      () => "run-1",
    );

    const firstStart = service.start({ threadId: "thread-1", actionId: "build" });
    const secondStart = service.start({ threadId: "thread-1", actionId: "build" });

    expect(startPreparedCommand).not.toHaveBeenCalled();
    environmentRead.resolve({ document: { version: "0.0.1", actions: [
      { id: "build", name: "Build", command: { default: "bun run build" } },
    ] } });
    await expect(secondStart).rejects.toMatchObject({ code: "WORKSPACE_ENVIRONMENT_ACTION_RUNNING" });
    await firstStart;

    expect(startPreparedCommand).toHaveBeenCalledOnce();
  });

  it("waits for an in-flight Action start before stopping the prepared session", async () => {
    const runs = new Runs();
    const startup = deferred<PreparedTerminalCommandSession>();
    const backendStarted = deferred<void>();
    const prepared = session("terminal-1");
    const service = new ProjectActionService(
      runs as never,
      { read: async () => ({ document: { version: "0.0.1", actions: [
        { id: "build", name: "Build", command: { default: "bun run build" } },
        { id: "test", name: "Test", command: { default: "bun test" } },
      ] } }) } as never,
      { findById: () => ({ id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: null }) } as never,
      {
        startPreparedCommand: () => {
          backendStarted.resolve();
          return startup.promise;
        },
      } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      () => "run-1",
    );

    const launching = service.start({ threadId: "thread-1", actionId: "build" });
    await backendStarted.promise;
    const stopping = service.stop({ threadId: "thread-1", actionId: "build" });
    startup.resolve(prepared);

    await Promise.all([launching, stopping]);
    expect(runs.get("thread-1", "build")?.status).toBe("interrupted");
  });

  it("persists a fast replayed exit as completed after the initial Action row exists", async () => {
    const runs = new Runs();
    const fast = session("terminal-1", { output: "fast output", exitCode: 0 });
    const service = new ProjectActionService(
      runs as never,
      { read: async () => ({ document: { version: "0.0.1", actions: [
        { id: "build", name: "Build", command: { default: "bun run build" } },
      ] } }) } as never,
      { findById: () => ({ id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: null }) } as never,
      { startPreparedCommand: async () => fast } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      () => "run-1",
    );

    await service.start({ threadId: "thread-1", actionId: "build" });

    expect(runs.get("thread-1", "build")).toMatchObject({
      status: "completed",
      transcript: "fast output",
      exitCode: 0,
    });
  });

  it("closes Action admission before thread teardown waits for an in-flight start", async () => {
    const runs = new Runs();
    const startup = deferred<PreparedTerminalCommandSession>();
    const enteredBackend = deferred<void>();
    const prepared = session("terminal-1");
    const service = new ProjectActionService(
      runs as never,
      { read: async () => ({ document: { version: "0.0.1", actions: [
        { id: "build", name: "Build", command: { default: "bun run build" } },
      ] } }) } as never,
      { findById: () => ({ id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: null }) } as never,
      { startPreparedCommand: () => { enteredBackend.resolve(); return startup.promise; } } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      () => "run-1",
    );

    const launching = service.start({ threadId: "thread-1", actionId: "build" });
    await enteredBackend.promise;
    const tearingDown = service.beginThreadTeardown("thread-1");
    await expect(service.start({ threadId: "thread-1", actionId: "test" })).rejects.toMatchObject({
      code: "WORKSPACE_ENVIRONMENT_NOT_FOUND",
    });
    startup.resolve(prepared);
    await launching;
    const release = await tearingDown;
    await service.stop({ threadId: "thread-1", actionId: "build" });
    release();

    expect(runs.get("thread-1", "build")?.status).toBe("interrupted");
  });

  it("keeps admission closed until every concurrent thread teardown releases its gate", async () => {
    const runs = new Runs();
    const prepared = session("terminal-1");
    const service = new ProjectActionService(
      runs as never,
      { read: async () => ({ document: { version: "0.0.1", actions: [
        { id: "build", name: "Build", command: { default: "bun run build" } },
      ] } }) } as never,
      { findById: () => ({ id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: null }) } as never,
      { startPreparedCommand: async () => prepared } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      () => "run-1",
    );

    const firstRelease = await service.beginThreadTeardown("thread-1");
    const secondRelease = await service.beginThreadTeardown("thread-1");
    firstRelease();
    await expect(service.start({ threadId: "thread-1", actionId: "test" })).rejects.toMatchObject({
      code: "WORKSPACE_ENVIRONMENT_NOT_FOUND",
    });
    secondRelease();

    await expect(service.start({ threadId: "thread-1", actionId: "build" })).resolves.toMatchObject({ status: "running" });
  });

  it("rejects starts while completed or disposed and restores admission only after reopen", async () => {
    const runs = new Runs();
    const thread = { id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: "2026-08-22T12:00:00.000Z" as string | null };
    const prepared = session("terminal-1");
    const service = new ProjectActionService(
      runs as never,
      { read: async () => ({ document: { version: "0.0.1", actions: [
        { id: "build", name: "Build", command: { default: "bun run build" } },
      ] } }) } as never,
      { findById: () => thread } as never,
      { startPreparedCommand: async () => prepared } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      () => "run-1",
    );

    await expect(service.start({ threadId: "thread-1", actionId: "build" })).rejects.toMatchObject({
      code: "WORKSPACE_ENVIRONMENT_NOT_FOUND",
    });
    thread.user_completed_at = null;
    service.reopenThread(thread.id);
    await expect(service.start({ threadId: "thread-1", actionId: "build" })).resolves.toMatchObject({ status: "running" });
    await service.dispose();
    await expect(service.start({ threadId: "thread-1", actionId: "build" })).rejects.toMatchObject({
      code: "WORKSPACE_ENVIRONMENT_NOT_FOUND",
    });
  });

  it("shares one idempotent shutdown barrier and stops its owned session once", async () => {
    const runs = new Runs();
    const prepared = session("terminal-1");
    const stop = vi.spyOn(prepared, "stop");
    const service = new ProjectActionService(
      runs as never,
      { read: async () => ({ document: { version: "0.0.1", actions: [
        { id: "build", name: "Build", command: { default: "bun run build" } },
      ] } }) } as never,
      { findById: () => ({ id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: null }) } as never,
      { startPreparedCommand: async () => prepared } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      () => "run-1",
    );
    await service.start({ threadId: "thread-1", actionId: "build" });

    const first = service.dispose();
    const second = service.dispose();
    expect(second).toBe(first);
    await Promise.all([first, second]);

    expect(stop).toHaveBeenCalledOnce();
    expect(runs.get("thread-1", "build")?.status).toBe("interrupted");
  });

  it("waits for an admitted start, stops it during shutdown, and rejects later starts", async () => {
    const runs = new Runs();
    const startup = deferred<PreparedTerminalCommandSession>();
    const enteredBackend = deferred<void>();
    const prepared = session("terminal-1");
    const service = new ProjectActionService(
      runs as never,
      { read: async () => ({ document: { version: "0.0.1", actions: [
        { id: "build", name: "Build", command: { default: "bun run build" } },
        { id: "test", name: "Test", command: { default: "bun test" } },
      ] } }) } as never,
      { findById: () => ({ id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: null }) } as never,
      { startPreparedCommand: () => { enteredBackend.resolve(); return startup.promise; } } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      () => "run-1",
    );

    const launching = service.start({ threadId: "thread-1", actionId: "build" });
    await enteredBackend.promise;
    const shuttingDown = service.dispose();
    await expect(service.start({ threadId: "thread-1", actionId: "test" })).rejects.toMatchObject({
      code: "WORKSPACE_ENVIRONMENT_NOT_FOUND",
    });
    startup.resolve(prepared);

    await Promise.all([launching, shuttingDown]);
    expect(runs.get("thread-1", "build")?.status).toBe("interrupted");
  });

  it("retains a failed planned attempt without disturbing a concurrent Action result", async () => {
    const runs = new Runs();
    const successful = session("terminal-1");
    const service = new ProjectActionService(
      runs as never,
      { read: async () => ({ document: { version: "0.0.1", actions: [
        { id: "build", name: "Build", command: { default: "bun run build" } },
        { id: "test", name: "Test", command: { default: "bun test" } },
      ] } }) } as never,
      { findById: () => ({ id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: null }) } as never,
      {
        startPreparedCommand: vi.fn()
          .mockResolvedValueOnce(successful)
          .mockRejectedValueOnce(new Error("capacity reached")),
      } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      (() => { let value = 0; return () => `run-${++value}`; })(),
    );

    await service.start({ threadId: "thread-1", actionId: "build" });
    const failed = await service.start({ threadId: "thread-1", actionId: "test" });

    expect(failed).toMatchObject({
      status: "failed",
      terminalSessionId: null,
      startedAt: "2026-08-22T12:00:00.001Z",
      snapshot: { script: "bun test", terminal: null, environmentNames: [] },
    });
    expect(runs.get("thread-1", "build")?.status).toBe("running");
  });

  it("retains resolved launch facts without inventing a terminal identity after pre-spawn failure", async () => {
    const runs = new Runs();
    const plannedSnapshot = {
      platform: "windows" as const,
      script: "bun run build",
      checkoutPath: "C:\\repo\\thread-1",
      terminal: { executable: "powershell.exe", arguments: ["-Command", "bun run build"] },
      environmentNames: ["PATH"],
    };
    const service = new ProjectActionService(
      runs as never,
      { read: async () => ({ document: { version: "0.0.1", actions: [
        { id: "build", name: "Build", command: { default: "bun run build" } },
      ] } }) } as never,
      { findById: () => ({ id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: null }) } as never,
      { startPreparedCommand: async () => { throw new PreparedTerminalCommandStartError(plannedSnapshot, new Error("host unavailable")); } } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      () => "run-1",
    );

    const failed = await service.start({ threadId: "thread-1", actionId: "build" });

    expect(failed).toMatchObject({
      status: "failed",
      terminalSessionId: null,
      snapshot: plannedSnapshot,
    });
  });

  it("closes a prepared session when retained-run persistence fails and preserves that failure", async () => {
    const prepared = session("terminal-1");
    const stop = vi.spyOn(prepared, "stop");
    const persistenceFailure = new Error("database unavailable");
    const service = new ProjectActionService(
      { get: () => null, list: () => [], replace: () => { throw persistenceFailure; }, updateIfCurrent: () => false, interruptRunning: () => [] } as never,
      { read: async () => ({ document: { version: "0.0.1", actions: [
        { id: "build", name: "Build", command: { default: "bun run build" } },
      ] } }) } as never,
      { findById: () => ({ id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: null }) } as never,
      { startPreparedCommand: async () => prepared } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      () => "run-1",
    );

    await expect(service.start({ threadId: "thread-1", actionId: "build" })).rejects.toBe(persistenceFailure);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("preserves the initial persistence failure after a fast exit already released its prepared session", async () => {
    const persistenceFailure = new Error("database unavailable");
    const stop = vi.fn(async () => undefined);
    const prepared = session("terminal-1", { output: "fast output", exitCode: 0 }, stop);
    const updateIfCurrent = vi.fn(() => false);
    const service = new ProjectActionService(
      {
        get: () => null,
        list: () => [],
        replace: () => { throw persistenceFailure; },
        updateIfCurrent,
        interruptRunning: () => [],
      } as never,
      { read: async () => ({ document: { version: "0.0.1", actions: [
        { id: "build", name: "Build", command: { default: "bun run build" } },
      ] } }) } as never,
      { findById: () => ({ id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: null }) } as never,
      { startPreparedCommand: async () => prepared } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      () => "run-1",
    );

    await expect(service.start({ threadId: "thread-1", actionId: "build" })).rejects.toBe(persistenceFailure);

    expect(stop).toHaveBeenCalledOnce();
    expect(updateIfCurrent).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      status: "interrupted",
      transcript: "",
    }));
  });

  it("keeps a failed-compensation session owned until a later stop succeeds", async () => {
    const runs = new Runs();
    const persistenceFailure = new Error("database unavailable");
    const cleanupFailure = new Error("terminal close unavailable");
    let prepared!: ReturnType<typeof session>;
    const stop = vi.fn()
      .mockRejectedValueOnce(cleanupFailure)
      .mockImplementationOnce(async () => prepared.exit(null));
    prepared = session("terminal-1", undefined, stop);
    const replacement = session("terminal-2");
    const replace = vi.spyOn(runs, "replace")
      .mockImplementationOnce(() => { throw persistenceFailure; });
    const service = new ProjectActionService(
      runs as never,
      { read: async () => ({ document: { version: "0.0.1", actions: [
        { id: "build", name: "Build", command: { default: "bun run build" } },
      ] } }) } as never,
      { findById: () => ({ id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: null }) } as never,
      { startPreparedCommand: vi.fn().mockResolvedValueOnce(prepared).mockResolvedValueOnce(replacement) } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      (() => { let value = 0; return () => `run-${++value}`; })(),
    );

    const failure = await service.start({ threadId: "thread-1", actionId: "build" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([persistenceFailure, cleanupFailure]);
    await expect(service.start({ threadId: "thread-1", actionId: "build" })).rejects.toMatchObject({
      code: "WORKSPACE_ENVIRONMENT_ACTION_RUNNING",
    });

    replace.mockRestore();
    await service.stop({ threadId: "thread-1", actionId: "build" });
    await expect(service.start({ threadId: "thread-1", actionId: "build" })).resolves.toMatchObject({
      terminalSessionId: "terminal-2",
    });
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("retries one exact natural-exit finalization during stop after persistence fails", async () => {
    const runs = new Runs();
    const first = session("terminal-1");
    const second = session("terminal-2");
    const updateIfCurrent = vi.spyOn(runs, "updateIfCurrent");
    const persist = Runs.prototype.updateIfCurrent.bind(runs);
    const persistenceFailure = new Error("database unavailable");
    updateIfCurrent
      .mockImplementationOnce(() => { throw persistenceFailure; })
      .mockImplementation((run) => persist(run));
    const service = new ProjectActionService(
      runs as never,
      { read: async () => ({ document: { version: "0.0.1", actions: [
        { id: "build", name: "Build", command: { default: "bun run build" } },
      ] } }) } as never,
      { findById: () => ({ id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: null }) } as never,
      { startPreparedCommand: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second) } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      (() => { let value = 0; return () => `run-${++value}`; })(),
    );
    await service.start({ threadId: "thread-1", actionId: "build" });

    expect(() => first.exit(0)).not.toThrow();
    expect(runs.get("thread-1", "build")).toMatchObject({ status: "running", revision: 0 });
    await expect(service.start({ threadId: "thread-1", actionId: "build" })).rejects.toMatchObject({
      code: "WORKSPACE_ENVIRONMENT_ACTION_RUNNING",
    });

    await service.stop({ threadId: "thread-1", actionId: "build" });

    expect(runs.get("thread-1", "build")).toMatchObject({
      runId: "run-1",
      status: "completed",
      revision: 1,
      exitCode: 0,
    });
    expect(updateIfCurrent.mock.calls.map(([run]) => ({
      runId: run.runId,
      status: run.status,
      revision: run.revision,
      exitCode: run.exitCode,
    }))).toEqual([
      { runId: "run-1", status: "completed", revision: 1, exitCode: 0 },
      { runId: "run-1", status: "completed", revision: 1, exitCode: 0 },
    ]);
    await expect(service.start({ threadId: "thread-1", actionId: "build" })).resolves.toMatchObject({
      terminalSessionId: "terminal-2",
    });
  });

  it("retries a pending natural-exit finalization before restarting its slot", async () => {
    const runs = new Runs();
    const first = session("terminal-1");
    const second = session("terminal-2");
    const updateIfCurrent = vi.spyOn(runs, "updateIfCurrent");
    const persist = Runs.prototype.updateIfCurrent.bind(runs);
    updateIfCurrent
      .mockImplementationOnce(() => { throw new Error("database unavailable"); })
      .mockImplementation((run) => persist(run));
    const service = new ProjectActionService(
      runs as never,
      { read: async () => ({ document: { version: "0.0.1", actions: [
        { id: "build", name: "Build", command: { default: "bun run build" } },
      ] } }) } as never,
      { findById: () => ({ id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: null }) } as never,
      { startPreparedCommand: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second) } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      (() => { let value = 0; return () => `run-${++value}`; })(),
    );
    await service.start({ threadId: "thread-1", actionId: "build" });
    first.exit(0);

    const restarted = await service.restart({ threadId: "thread-1", actionId: "build" });

    expect(restarted).toMatchObject({ runId: "run-2", terminalSessionId: "terminal-2", status: "running" });
    expect(updateIfCurrent.mock.calls.map(([run]) => ({
      runId: run.runId,
      status: run.status,
      revision: run.revision,
    }))).toEqual([
      { runId: "run-1", status: "completed", revision: 1 },
      { runId: "run-1", status: "completed", revision: 1 },
    ]);
  });

  it("retries a pending natural-exit finalization during disposal without retaining the slot", async () => {
    const runs = new Runs();
    const prepared = session("terminal-1");
    const updateIfCurrent = vi.spyOn(runs, "updateIfCurrent");
    const persist = Runs.prototype.updateIfCurrent.bind(runs);
    updateIfCurrent
      .mockImplementationOnce(() => { throw new Error("database unavailable"); })
      .mockImplementation((run) => persist(run));
    const service = new ProjectActionService(
      runs as never,
      { read: async () => ({ document: { version: "0.0.1", actions: [
        { id: "build", name: "Build", command: { default: "bun run build" } },
      ] } }) } as never,
      { findById: () => ({ id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: null }) } as never,
      { startPreparedCommand: async () => prepared } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      () => "run-1",
    );
    await service.start({ threadId: "thread-1", actionId: "build" });
    prepared.exit(3);

    await service.dispose();
    await service.stop({ threadId: "thread-1", actionId: "build" });

    expect(runs.get("thread-1", "build")).toMatchObject({
      runId: "run-1",
      status: "failed",
      revision: 1,
      exitCode: 3,
    });
    expect(updateIfCurrent.mock.calls.map(([run]) => ({
      status: run.status,
      revision: run.revision,
      exitCode: run.exitCode,
    }))).toEqual([
      { status: "failed", revision: 1, exitCode: 3 },
      { status: "failed", revision: 1, exitCode: 3 },
    ]);
  });

  it("releases an Action slot after final persistence even if a push listener throws", async () => {
    const runs = new Runs();
    const first = session("terminal-1");
    const second = session("terminal-2");
    const service = new ProjectActionService(
      runs as never,
      { read: async () => ({ document: { version: "0.0.1", actions: [
        { id: "build", name: "Build", command: { default: "bun run build" } },
      ] } }) } as never,
      { findById: () => ({ id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: null }) } as never,
      { startPreparedCommand: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second) } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      (() => { let value = 0; return () => `run-${++value}`; })(),
    );
    await service.start({ threadId: "thread-1", actionId: "build" });
    const listenerFailure = new Error("push unavailable");
    service.onUpdate((update) => {
      if (update.run.status === "completed") throw listenerFailure;
    });

    expect(() => first.exit(0)).toThrow(listenerFailure);
    expect(runs.get("thread-1", "build")?.status).toBe("completed");
    await expect(service.start({ threadId: "thread-1", actionId: "build" })).resolves.toMatchObject({
      terminalSessionId: "terminal-2",
    });
  });

  it("keeps terminal output and final persistence alive after an output write failure", async () => {
    const runs = new Runs();
    const prepared = session("terminal-1");
    const updateIfCurrent = vi.spyOn(runs, "updateIfCurrent");
    const persist = Runs.prototype.updateIfCurrent.bind(runs);
    updateIfCurrent
      .mockImplementationOnce(() => { throw new Error("database unavailable"); })
      .mockImplementation((run) => persist(run));
    const service = new ProjectActionService(
      runs as never,
      { read: async () => ({ document: { version: "0.0.1", actions: [
        { id: "build", name: "Build", command: { default: "bun run build" } },
      ] } }) } as never,
      { findById: () => ({ id: "thread-1", workspace_id: "workspace-1", deleted_at: null, user_completed_at: null }) } as never,
      { startPreparedCommand: async () => prepared } as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
      () => "run-1",
    );
    await service.start({ threadId: "thread-1", actionId: "build" });

    expect(() => prepared.emit("retained output")).not.toThrow();
    prepared.exit(0);

    expect(runs.get("thread-1", "build")).toMatchObject({
      status: "completed",
      transcript: "retained output",
      revision: 2,
      exitCode: 0,
    });
  });

  it("reaps every stale Action batch instead of stopping after the first 256 rows", () => {
    const first = Array.from({ length: 256 }, (_, index) => ({ actionId: `first-${index}` } as WorkspaceEnvironmentActionRun));
    const second = Array.from({ length: 2 }, (_, index) => ({ actionId: `second-${index}` } as WorkspaceEnvironmentActionRun));
    const interruptRunning = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const service = new ProjectActionService(
      { get: () => null, list: () => [], replace: vi.fn(), updateIfCurrent: () => false, interruptRunning } as never,
      {} as never,
      {} as never,
      {} as never,
      () => new Date("2026-08-22T12:00:00.000Z"),
    );

    expect(service.recoverStaleRuns()).toHaveLength(258);
    expect(interruptRunning).toHaveBeenCalledTimes(2);
  });
});
