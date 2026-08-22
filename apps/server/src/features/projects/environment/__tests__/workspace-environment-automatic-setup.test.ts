import "reflect-metadata";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { reapOrphanedPtys } from "../../../../runtime/process/orphan-cleanup.js";
import { PtyPidRegistry } from "../../../terminal/host/pty-pid-registry.js";
import { WorkspaceEnvironmentService } from "../workspace-environment-service.js";
import type { TerminalCommandCompletion } from "../../../terminal/commands/terminal-command-service.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

async function eventually(assertion: () => void): Promise<void> {
  let failure: unknown;
  for (let index = 0; index < 32; index += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      failure = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw failure;
}

async function automaticHarness({ setup = true, prepareFailure = false }: {
  readonly setup?: boolean;
  readonly prepareFailure?: boolean;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "mcode-automatic-setup-"));
  roots.push(root);
  const db = openMemoryDatabase();
  db.prepare("INSERT INTO workspaces (id, name, path, provider_config) VALUES ('workspace-1', 'Project', '/project', '{}')").run();
  db.prepare("INSERT INTO threads (id, workspace_id, title, mode, branch, worktree_managed, provider) VALUES ('thread-1', 'workspace-1', 'First Turn', 'worktree', 'main', 1, 'claude')").run();
  const completion = deferred<TerminalCommandCompletion>();
  const start = vi.fn(() => completion.promise);
  const close = vi.fn(async () => ({ kind: "contained" as const }));
  const prepare = vi.fn(async () => {
    if (prepareFailure) throw new Error("terminal preparation failed");
    return {
      kind: "ready" as const,
      command: {
        snapshot: { checkoutPath: "/project/.worktrees/first", terminal: { executable: "sh", arguments: ["-c", "bun run setup"] } },
        start,
        close,
        waitForRelease: async () => await new Promise<never>(() => undefined),
      },
    };
  });
  const terminalCommands = {
    prepare,
  };
  const service = new WorkspaceEnvironmentService({
    mcodeDir: root,
    database: db,
    threads: { findById: (id) => id === "thread-1" ? { id, workspace_id: "workspace-1", mode: "worktree", worktree_managed: true } : null },
    terminalCommands,
    platform: "linux",
  });
  if (setup) {
    await service.save({
      workspaceId: "workspace-1",
      sourceRevision: null,
      document: { version: "0.0.1", setup: { linux: "bun run setup" }, actions: [] },
    });
  }
  return { root, db, service, completion, start, close, prepare, terminalCommands };
}

function queuedInput() {
  return {
    threadId: "thread-1",
    messageId: "message-1",
    content: "Build the feature",
    attachments: [],
    mentions: [],
    submission: {
      threadId: "thread-1",
      messageId: "message-1",
      content: "Build the feature",
      displayContent: "Build the feature",
      model: "claude-sonnet-4-6",
      permissionMode: "default" as const,
      attachments: [],
      persistedAttachments: [],
      mentions: [],
      provider: "claude",
    },
  };
}

describe("automatic Project Setup", () => {
  it("persists the visible first Turn before Setup, then commits pass and release before dispatch", async () => {
    const { db, service, completion, start } = await automaticHarness();
    const dispatch = vi.fn(async () => {
      expect(service.getAutomaticSetup({ threadId: "thread-1" })).toMatchObject({
        gate: "released-by-pass",
        attempt: { state: "passed" },
        queuedTurn: { state: "dispatching" },
      });
    });
    service.setAutomaticSetupDispatcher({ dispatch });

    expect(service.queueAutomaticFirstTurn(queuedInput())).toMatchObject({
      gate: "blocked",
      attempt: { state: "queued" },
      queuedTurn: { state: "queued", messageId: "message-1" },
    });
    expect((db.prepare("SELECT content FROM messages WHERE id = 'message-1'").get() as { content: string }).content).toBe("Build the feature");

    await eventually(() => expect(start).toHaveBeenCalledOnce());
    completion.resolve({ kind: "exited", exitCode: 0, output: "done", outputTruncated: false });
    await eventually(() => expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ messageId: "message-1" })));

    expect(service.getAutomaticSetup({ threadId: "thread-1" })).toMatchObject({
      gate: "released-by-pass",
      attempt: {
        state: "passed",
        snapshot: { script: "bun run setup", checkoutPath: "/project/.worktrees/first" },
        outcome: "success",
        exitCode: 0,
        output: "done",
      },
      queuedTurn: { state: "dispatched", dispatchedAt: expect.any(String) },
    });
  });

  it("releases a managed New worktree without Setup and dispatches without launching Terminal Setup", async () => {
    const { service, start, prepare } = await automaticHarness({ setup: false });
    const dispatch = vi.fn().mockResolvedValue(undefined);
    service.setAutomaticSetupDispatcher({ dispatch });

    service.queueAutomaticFirstTurn(queuedInput());
    await eventually(() => expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ messageId: "message-1" })));

    expect(prepare).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(service.getAutomaticSetup({ threadId: "thread-1" })).toMatchObject({
      gate: "not-required",
      attempt: null,
      queuedTurn: { state: "dispatched", dispatchedAt: expect.any(String) },
    });
  });

  it("cancels only a queued first Turn and leaves the Setup command running", async () => {
    const { db, service, close, start } = await automaticHarness();
    service.queueAutomaticFirstTurn(queuedInput());
    await eventually(() => expect(start).toHaveBeenCalledOnce());
    const cancelled = service.cancelQueuedAutomaticTurn({ threadId: "thread-1" });

    expect(cancelled.queuedTurn?.state).toBe("cancelled");
    expect(db.prepare("SELECT id FROM messages WHERE id = 'message-1'").get()).toBeUndefined();
    expect(close).not.toHaveBeenCalled();
  });

  it("keeps a failed Setup gate blocked and never dispatches its first Turn", async () => {
    const { service, completion, start } = await automaticHarness();
    const dispatch = vi.fn().mockResolvedValue(undefined);
    service.setAutomaticSetupDispatcher({ dispatch });
    service.queueAutomaticFirstTurn(queuedInput());
    await eventually(() => expect(start).toHaveBeenCalledOnce());

    completion.resolve({ kind: "exited", exitCode: 1, output: "failed", outputTruncated: false });
    await eventually(() => expect(service.getAutomaticSetup({ threadId: "thread-1" }).attempt?.state).toBe("failed"));

    expect(service.getAutomaticSetup({ threadId: "thread-1" })).toMatchObject({
      gate: "blocked",
      attempt: {
        state: "failed",
        reason: "setup_failed",
        outcome: "command_failure",
        exitCode: 1,
        output: "failed",
      },
      queuedTurn: { state: "queued" },
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("starts automatic Setup and releases a first Turn at most once", async () => {
    const { service, completion, start } = await automaticHarness();
    const dispatch = vi.fn().mockResolvedValue(undefined);
    service.setAutomaticSetupDispatcher({ dispatch });

    service.queueAutomaticFirstTurn(queuedInput());
    service.queueAutomaticFirstTurn(queuedInput());
    await eventually(() => expect(start).toHaveBeenCalledOnce());

    await Promise.all([
      service.continueAutomaticSetup({ threadId: "thread-1" }),
      service.continueAutomaticSetup({ threadId: "thread-1" }),
    ]);

    expect(dispatch).toHaveBeenCalledOnce();
    completion.resolve({ kind: "exited", exitCode: 0, output: "done", outputTruncated: false });
  });

  it("keeps a failed dispatcher claim stable across restart without redispatching", async () => {
    const { root, db, service, completion, start, terminalCommands } = await automaticHarness();
    const failedDispatch = vi.fn().mockRejectedValue(new Error("provider unavailable"));
    service.setAutomaticSetupDispatcher({ dispatch: failedDispatch });
    service.queueAutomaticFirstTurn(queuedInput());
    await eventually(() => expect(start).toHaveBeenCalledOnce());

    completion.resolve({ kind: "exited", exitCode: 0, output: "done", outputTruncated: false });
    await eventually(() => expect(failedDispatch).toHaveBeenCalledOnce());
    expect(service.getAutomaticSetup({ threadId: "thread-1" }).queuedTurn).toMatchObject({ state: "dispatching", dispatchedAt: null });

    const reloaded = new WorkspaceEnvironmentService({
      mcodeDir: root,
      database: db,
      threads: { findById: (id) => id === "thread-1" ? { id, workspace_id: "workspace-1", mode: "worktree", worktree_managed: true } : null },
      terminalCommands,
      platform: "linux",
    });
    const redispatch = vi.fn().mockResolvedValue(undefined);
    reloaded.setAutomaticSetupDispatcher({ dispatch: redispatch });
    await reloaded.reconcileAutomaticSetup();

    expect(redispatch).not.toHaveBeenCalled();
    expect(reloaded.getAutomaticSetup({ threadId: "thread-1" }).queuedTurn).toMatchObject({ state: "dispatching", dispatchedAt: null });
  });

  it("classifies read and preparation failures without leaving a queued attempt unresolved", async () => {
    const readFailure = await automaticHarness();
    vi.spyOn(readFailure.service, "read").mockRejectedValue(new Error("filesystem unavailable"));
    readFailure.service.queueAutomaticFirstTurn(queuedInput());
    await eventually(() => expect(readFailure.service.getAutomaticSetup({ threadId: "thread-1" }).attempt?.state).toBe("failed"));
    expect(readFailure.service.getAutomaticSetup({ threadId: "thread-1" })).toMatchObject({
      gate: "blocked",
      attempt: { reason: "setup_unavailable", outcome: "unavailable" },
      queuedTurn: { state: "queued" },
    });

    const preparationFailure = await automaticHarness({ prepareFailure: true });
    preparationFailure.service.queueAutomaticFirstTurn(queuedInput());
    await eventually(() => expect(preparationFailure.service.getAutomaticSetup({ threadId: "thread-1" }).attempt?.state).toBe("failed"));
    expect(preparationFailure.service.getAutomaticSetup({ threadId: "thread-1" })).toMatchObject({
      gate: "blocked",
      attempt: { reason: "setup_unavailable", outcome: "launch_failure" },
      queuedTurn: { state: "queued" },
    });
  });

  it("interrupts unfinished Setup at restart without rerunning the command", async () => {
    const { root, db, completion, start, terminalCommands } = await automaticHarness();
    const service = new WorkspaceEnvironmentService({
      mcodeDir: root,
      database: db,
      threads: { findById: (id) => id === "thread-1" ? { id, workspace_id: "workspace-1", mode: "worktree", worktree_managed: true } : null },
      terminalCommands,
      platform: "linux",
    });
    service.queueAutomaticFirstTurn(queuedInput());
    await eventually(() => expect(start).toHaveBeenCalledOnce());

    const reloaded = new WorkspaceEnvironmentService({
      mcodeDir: root,
      database: db,
      threads: { findById: (id) => id === "thread-1" ? { id, workspace_id: "workspace-1", mode: "worktree", worktree_managed: true } : null },
      terminalCommands,
      platform: "linux",
    });
    const dispatch = vi.fn().mockResolvedValue(undefined);
    reloaded.setAutomaticSetupDispatcher({ dispatch });
    await reloaded.reconcileAutomaticSetup();

    expect(reloaded.getAutomaticSetup({ threadId: "thread-1" })).toMatchObject({
      gate: "blocked",
      attempt: { state: "interrupted", reason: "setup_interrupted" },
      queuedTurn: { state: "queued" },
    });
    expect(start).toHaveBeenCalledOnce();
    completion.resolve({ kind: "exited", exitCode: 0, output: "done", outputTruncated: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("reaps a stale automatic Setup command before restart marks its attempt interrupted", async () => {
    const { root, db, service, start, terminalCommands } = await automaticHarness();
    service.queueAutomaticFirstTurn(queuedInput());
    await eventually(() => expect(start).toHaveBeenCalledOnce());

    const registry = new PtyPidRegistry(root);
    registry.register("terminal-command:automatic-setup", 421, "sh");
    const processKill = vi.fn();
    reapOrphanedPtys(registry, { warn: vi.fn(), debug: vi.fn() }, {
      platform: "linux",
      processKill,
      getProcessName: () => "sh",
    });

    const reloaded = new WorkspaceEnvironmentService({
      mcodeDir: root,
      database: db,
      threads: { findById: (id) => id === "thread-1" ? { id, workspace_id: "workspace-1", mode: "worktree", worktree_managed: true } : null },
      terminalCommands,
      platform: "linux",
    });
    await reloaded.reconcileAutomaticSetup();

    expect(processKill).toHaveBeenCalledWith(421, 0);
    expect(processKill).toHaveBeenCalledWith(-421, "SIGKILL");
    expect(reloaded.getAutomaticSetup({ threadId: "thread-1" })).toMatchObject({
      attempt: { state: "interrupted", reason: "setup_interrupted" },
    });
  });

  it("preserves a Continue release while restart interruption repairs the unfinished Setup attempt", async () => {
    const { root, db, service, start, terminalCommands } = await automaticHarness();
    service.queueAutomaticFirstTurn(queuedInput());
    await eventually(() => expect(start).toHaveBeenCalledOnce());
    await service.continueAutomaticSetup({ threadId: "thread-1" });

    const reloaded = new WorkspaceEnvironmentService({
      mcodeDir: root,
      database: db,
      threads: { findById: (id) => id === "thread-1" ? { id, workspace_id: "workspace-1", mode: "worktree", worktree_managed: true } : null },
      terminalCommands,
      platform: "linux",
    });
    await reloaded.reconcileAutomaticSetup();

    expect(reloaded.getAutomaticSetup({ threadId: "thread-1" })).toMatchObject({
      gate: "released-by-continue",
      attempt: { state: "interrupted", reason: "setup_interrupted" },
      queuedTurn: { state: "released", dispatchedAt: null },
    });
  });
});
