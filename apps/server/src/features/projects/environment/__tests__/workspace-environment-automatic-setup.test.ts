import "reflect-metadata";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { reapOrphanedPtys } from "../../../../runtime/process/orphan-cleanup.js";
import { PtyPidRegistry } from "../../../terminal/host/pty-pid-registry.js";
import { WorkspaceEnvironmentService } from "../workspace-environment-service.js";
import { WorkspaceEnvironmentAutomaticRepository } from "../workspace-environment-automatic-repository.js";
import type { TerminalCommandCompletion, TerminalCommandPreparation } from "../../../terminal/commands/terminal-command-service.js";

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

async function automaticHarness({ setup = true, prepareFailure = false, attachmentStorage }: {
  readonly setup?: boolean;
  readonly prepareFailure?: boolean;
  readonly attachmentStorage?: { removeStoredAttachments: ReturnType<typeof vi.fn> };
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "mcode-automatic-setup-"));
  roots.push(root);
  const db = openMemoryDatabase();
  let milliseconds = Date.parse("2026-08-24T12:00:00.000Z");
  db.prepare("INSERT INTO workspaces (id, name, path, provider_config) VALUES ('workspace-1', 'Project', '/project', '{}')").run();
  db.prepare("INSERT INTO threads (id, workspace_id, title, mode, branch, worktree_managed, provider) VALUES ('thread-1', 'workspace-1', 'First Turn', 'worktree', 'main', 1, 'claude')").run();
  const completion = deferred<TerminalCommandCompletion>();
  const start = vi.fn(() => completion.promise);
  const close = vi.fn(async () => ({ kind: "contained" as const }));
  const prepare = vi.fn(async (_input?: unknown) => {
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
  const terminalRecovery = { create: vi.fn(() => ({ ptyId: "recovery-pty", shell: "sh" })) };
  const service = new WorkspaceEnvironmentService({
    mcodeDir: root,
    database: db,
    threads: { findById: (id) => id === "thread-1" ? { id, workspace_id: "workspace-1", mode: "worktree", worktree_managed: true } : null },
    terminalCommands,
    terminalRecovery,
    attachmentStorage,
    platform: "linux",
    now: () => new Date(milliseconds++),
  });
  if (setup) {
    await service.save({
      workspaceId: "workspace-1",
      sourceRevision: null,
      document: { version: "0.0.1", setup: { linux: "bun run setup" }, actions: [] },
    });
  }
  return { root, db, service, completion, start, close, prepare, terminalCommands, terminalRecovery };
}

function queuedInput(index = 1) {
  const messageId = `message-${index}`;
  const content = index === 1 ? "Build the feature" : `Build the feature ${index}`;
  return {
    threadId: "thread-1",
    messageId,
    content,
    attachments: [],
    mentions: [],
    submission: {
      threadId: "thread-1",
      messageId,
      content,
      displayContent: content,
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
        queuedTurns: [{ state: "dispatching" }],
      });
      return { completion: Promise.resolve() };
    });
    service.setAutomaticSetupDispatcher({ dispatch });

    expect(service.queueAutomaticFirstTurn(queuedInput())).toMatchObject({
      gate: "blocked",
      attempt: { state: "queued" },
      queuedTurns: [{ state: "queued", messageId: "message-1" }],
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
      queuedTurns: [{ state: "dispatched", dispatchedAt: expect.any(String) }],
    });
  });

  it("persists selected-text comments unchanged while automatic Setup queues the Turn", async () => {
    const { db, service } = await automaticHarness();
    const selectedTextComments = [{
      id: "76da3c6e-6b42-4c01-aaf2-3ad0b29a4756",
      displayNumber: 1 as const,
      source: {
        threadId: "thread-1",
        messageId: "assistant-1",
        sourceRole: "assistant" as const,
        start: 0,
        end: 11,
        quote: "Select this",
      },
      note: "Explain this.",
      mentions: [],
    }];
    const input = queuedInput();

    service.queueAutomaticFirstTurn({
      ...input,
      submission: { ...input.submission, selectedTextComments },
    });

    expect(JSON.parse((db.prepare(
      "SELECT selected_text_comments FROM messages WHERE id = 'message-1'",
    ).get() as { selected_text_comments: string }).selected_text_comments)).toEqual(selectedTextComments);
    expect(JSON.parse((db.prepare(
      "SELECT submission_json FROM workspace_environment_queued_turns WHERE message_id = 'message-1'",
    ).get() as { submission_json: string }).submission_json).selectedTextComments).toEqual(selectedTextComments);
  });

  it("releases a managed New worktree without Setup and dispatches without launching Terminal Setup", async () => {
    const { service, start, prepare } = await automaticHarness({ setup: false });
    const dispatch = vi.fn().mockResolvedValue({ completion: Promise.resolve() });
    service.setAutomaticSetupDispatcher({ dispatch });

    service.queueAutomaticFirstTurn(queuedInput());
    await eventually(() => expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ messageId: "message-1" })));

    expect(prepare).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(service.getAutomaticSetup({ threadId: "thread-1" })).toMatchObject({
      gate: "not-required",
      attempt: null,
      queuedTurns: [{ state: "dispatched", dispatchedAt: expect.any(String) }],
    });
  });

  it("cancels only the targeted queued Turn and leaves the Setup command running", async () => {
    const { db, service, close, start } = await automaticHarness();
    service.queueAutomaticFirstTurn(queuedInput());
    service.queueAutomaticFirstTurn(queuedInput(2));
    await eventually(() => expect(start).toHaveBeenCalledOnce());
    const firstQueuedTurn = service.getAutomaticSetup({ threadId: "thread-1" }).queuedTurns[0]!;
    const cancelled = await service.cancelQueuedAutomaticTurn({ threadId: "thread-1", queuedTurnId: firstQueuedTurn.id });

    expect(cancelled.queuedTurns).toMatchObject([
      { id: firstQueuedTurn.id, state: "cancelled" },
      { messageId: "message-2", state: "queued" },
    ]);
    expect(db.prepare("SELECT id FROM messages WHERE id = 'message-1'").get()).toBeUndefined();
    expect(db.prepare("SELECT id FROM messages WHERE id = 'message-2'").get()).toMatchObject({ id: "message-2" });
    expect(close).not.toHaveBeenCalled();
  });

  it("removes only the cancelled queued Turn's stored attachments", async () => {
    const attachmentStorage = { removeStoredAttachments: vi.fn(async () => undefined) };
    const { service } = await automaticHarness({ attachmentStorage });
    const firstAttachment = { id: "queued-file-1", name: "first.png", mimeType: "image/png", sizeBytes: 4 };
    const secondAttachment = { id: "queued-file-2", name: "second.png", mimeType: "image/png", sizeBytes: 4 };
    for (const [messageId, attachment] of [["message-1", firstAttachment], ["message-2", secondAttachment]] as const) {
      service.queueAutomaticFirstTurn({
        threadId: "thread-1",
        messageId,
        content: messageId,
        attachments: [attachment],
        mentions: [],
        submission: {
          threadId: "thread-1",
          messageId,
          content: messageId,
          displayContent: messageId,
          model: "claude-sonnet-4-6",
          permissionMode: "default",
          attachments: [attachment],
          persistedAttachments: [{ ...attachment, sourcePath: `/tmp/${attachment.id}.png` }],
          mentions: [],
          provider: "claude",
        },
      });
    }
    const firstQueuedTurn = service.getAutomaticSetup({ threadId: "thread-1" }).queuedTurns[0]!;

    await service.cancelQueuedAutomaticTurn({ threadId: "thread-1", queuedTurnId: firstQueuedTurn.id });

    expect(attachmentStorage.removeStoredAttachments).toHaveBeenCalledWith("thread-1", [firstAttachment]);
    expect(attachmentStorage.removeStoredAttachments).not.toHaveBeenCalledWith("thread-1", [secondAttachment]);
  });

  it("rejects the next active queued Turn at the per-Thread capacity boundary", async () => {
    const { service } = await automaticHarness();

    for (let index = 1; index <= 64; index += 1) service.queueAutomaticFirstTurn(queuedInput(index));

    let error: unknown;
    try {
      service.queueAutomaticFirstTurn(queuedInput(65));
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "WORKSPACE_ENVIRONMENT_SETUP_CAPACITY" });
    expect(service.getAutomaticSetup({ threadId: "thread-1" }).queuedTurns).toHaveLength(64);
  });

  it("retains only the latest terminal queued Turns without pruning active rows", async () => {
    const { service } = await automaticHarness();
    for (let index = 1; index <= 33; index += 1) service.queueAutomaticFirstTurn(queuedInput(index));

    for (const queuedTurn of service.getAutomaticSetup({ threadId: "thread-1" }).queuedTurns) {
      await service.cancelQueuedAutomaticTurn({ threadId: "thread-1", queuedTurnId: queuedTurn.id });
    }

    const snapshot = service.getAutomaticSetup({ threadId: "thread-1" });
    expect(snapshot.queuedTurns).toHaveLength(32);
    expect(snapshot.queuedTurns.every((queuedTurn) => queuedTurn.state === "cancelled")).toBe(true);
    expect(snapshot.queuedTurns.some((queuedTurn) => queuedTurn.messageId === "message-1")).toBe(false);
  });

  it("keeps a failed Setup gate blocked and never dispatches its first Turn", async () => {
    const { service, completion, start } = await automaticHarness();
    const dispatch = vi.fn().mockResolvedValue({ completion: Promise.resolve() });
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
      queuedTurns: [{ state: "queued" }],
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects Continue while automatic Setup is still running without releasing queued Turns", async () => {
    const { service, start } = await automaticHarness();
    service.queueAutomaticFirstTurn(queuedInput());
    await eventually(() => expect(start).toHaveBeenCalledOnce());

    await expect(service.continueAutomaticSetup({ threadId: "thread-1" })).rejects.toMatchObject({
      code: "WORKSPACE_ENVIRONMENT_SETUP_UNAVAILABLE",
    });

    expect(service.getAutomaticSetup({ threadId: "thread-1" })).toMatchObject({
      gate: "blocked",
      attempt: { state: "running" },
      queuedTurns: [{ state: "queued" }],
    });
  });

  it("persists multiple blocked Turns and releases them FIFO exactly once", async () => {
    const { service, completion, start } = await automaticHarness();
    const dispatch = vi.fn().mockResolvedValue({ completion: Promise.resolve() });
    service.setAutomaticSetupDispatcher({ dispatch });

    service.queueAutomaticFirstTurn(queuedInput());
    service.queueAutomaticFirstTurn(queuedInput(2));
    await eventually(() => expect(start).toHaveBeenCalledOnce());
    completion.resolve({ kind: "exited", exitCode: 1, output: "failed", outputTruncated: false });
    await eventually(() => expect(service.getAutomaticSetup({ threadId: "thread-1" }).attempt?.state).toBe("failed"));

    await Promise.all([
      service.continueAutomaticSetup({ threadId: "thread-1" }),
      service.continueAutomaticSetup({ threadId: "thread-1" }),
    ]);

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls.map(([submission]) => submission.messageId)).toEqual(["message-1", "message-2"]);
    completion.resolve({ kind: "exited", exitCode: 0, output: "done", outputTruncated: false });
  });

  it("serializes released Turns until the prior provider Turn completes without blocking duplicate Continue calls", async () => {
    const { service, start, completion } = await automaticHarness();
    const firstCompletion = deferred<void>();
    const dispatchedMessages: string[] = [];
    const dispatch = vi.fn(async (submission: { readonly messageId: string }) => {
      dispatchedMessages.push(submission.messageId);
      return { completion: submission.messageId === "message-1" ? firstCompletion.promise : Promise.resolve() };
    });
    service.setAutomaticSetupDispatcher({ dispatch });
    service.queueAutomaticFirstTurn(queuedInput());
    service.queueAutomaticFirstTurn(queuedInput(2));
    await eventually(() => expect(start).toHaveBeenCalledOnce());

    completion.resolve({ kind: "exited", exitCode: 1, output: "failed", outputTruncated: false });
    await eventually(() => expect(service.getAutomaticSetup({ threadId: "thread-1" }).attempt?.state).toBe("failed"));

    await Promise.all([
      service.continueAutomaticSetup({ threadId: "thread-1" }),
      service.continueAutomaticSetup({ threadId: "thread-1" }),
    ]);

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatchedMessages).toEqual(["message-1"]);
    expect(service.getAutomaticSetup({ threadId: "thread-1" }).queuedTurns).toMatchObject([
      { messageId: "message-1", state: "dispatched" },
      { messageId: "message-2", state: "released" },
    ]);

    firstCompletion.resolve();
    await eventually(() => expect(dispatch).toHaveBeenCalledTimes(2));
    expect(dispatchedMessages).toEqual(["message-1", "message-2"]);
  });

  it("dispatches equal-timestamp queued Turns in durable admission order", async () => {
    const { db, service, completion, start } = await automaticHarness();
    const dispatched: string[] = [];
    service.setAutomaticSetupDispatcher({
      dispatch: vi.fn(async (submission) => {
        dispatched.push(submission.messageId);
        return { completion: Promise.resolve() };
      }),
    });
    service.queueAutomaticFirstTurn(queuedInput());
    service.queueAutomaticFirstTurn(queuedInput(2));
    service.queueAutomaticFirstTurn(queuedInput(3));
    db.prepare("UPDATE workspace_environment_queued_turns SET created_at = ? WHERE thread_id = ?")
      .run("2026-08-24T12:00:00.000Z", "thread-1");
    await eventually(() => expect(start).toHaveBeenCalledOnce());

    completion.resolve({ kind: "exited", exitCode: 1, output: "failed", outputTruncated: false });
    await eventually(() => expect(service.getAutomaticSetup({ threadId: "thread-1" }).attempt?.state).toBe("failed"));
    await service.continueAutomaticSetup({ threadId: "thread-1" });
    await eventually(() => expect(dispatched).toHaveLength(3));

    expect(dispatched).toEqual(["message-1", "message-2", "message-3"]);
  });

  it("joins delayed automatic preparation and closes the late command before Thread deletion returns", async () => {
    const { service, prepare } = await automaticHarness();
    const pending = deferred<TerminalCommandPreparation>();
    const start = vi.fn();
    const close = vi.fn(async () => ({ kind: "contained" as const }));
    prepare.mockImplementation(() => pending.promise);
    service.queueAutomaticFirstTurn(queuedInput());
    await eventually(() => expect(prepare).toHaveBeenCalledOnce());

    const releaseDeletion = service.beginThreadDeletion("thread-1");
    const deleting = service.cancelSetupForThread("thread-1");
    let returned = false;
    void deleting.then(() => { returned = true; });
    await Promise.resolve();
    expect(returned).toBe(false);

    pending.resolve({
      kind: "ready",
      command: {
        snapshot: { checkoutPath: "/project/.worktrees/first", terminal: { executable: "sh", arguments: ["-c", "bun run setup"] } },
        start,
        close,
        waitForRelease: async () => await new Promise<never>(() => undefined),
      },
    });

    await deleting;
    expect(close).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
    releaseDeletion();
  });

  it("joins delayed automatic preparation and closes the late command before workspace deletion returns", async () => {
    const { service, prepare } = await automaticHarness();
    const pending = deferred<TerminalCommandPreparation>();
    const start = vi.fn();
    const close = vi.fn(async () => ({ kind: "contained" as const }));
    prepare.mockImplementation(() => pending.promise);
    service.queueAutomaticFirstTurn(queuedInput());
    await eventually(() => expect(prepare).toHaveBeenCalledOnce());

    const releaseDeletion = service.beginWorkspaceDeletion("workspace-1");
    const deleting = service.cancelSetupForWorkspace("workspace-1");
    pending.resolve({
      kind: "ready",
      command: {
        snapshot: { checkoutPath: "/project/.worktrees/first", terminal: { executable: "sh", arguments: ["-c", "bun run setup"] } },
        start,
        close,
        waitForRelease: async () => await new Promise<never>(() => undefined),
      },
    });

    await deleting;
    expect(close).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
    releaseDeletion();
  });

  it("prevents a delayed automatic environment read from launching Setup while disposal joins it", async () => {
    const { service, prepare } = await automaticHarness();
    const pendingRead = deferred<Awaited<ReturnType<WorkspaceEnvironmentService["read"]>>>();
    vi.spyOn(service, "read").mockReturnValue(pendingRead.promise);
    service.queueAutomaticFirstTurn(queuedInput());

    const disposing = service.dispose();
    let disposed = false;
    void disposing.then(() => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);

    pendingRead.resolve({
      document: { version: "0.0.1", setup: { linux: "bun run setup" }, actions: [] },
      revision: "current",
      status: "present",
    });

    await disposing;
    expect(prepare).not.toHaveBeenCalled();
  });

  it("closes a running automatic command before Thread deletion cleanup returns", async () => {
    const { service, close, start } = await automaticHarness();
    service.queueAutomaticFirstTurn(queuedInput());
    await eventually(() => expect(start).toHaveBeenCalledOnce());

    const releaseDeletion = service.beginThreadDeletion("thread-1");
    await service.cancelSetupForThread("thread-1");

    expect(close).toHaveBeenCalledOnce();
    expect(service.getAutomaticSetup({ threadId: "thread-1" }).attempt?.state).toBe("interrupted");
    releaseDeletion();
  });

  it("fails closed for malformed persisted automatic snapshots and queued submissions", async () => {
    const { db, service, prepare, start } = await automaticHarness();
    const repository = new WorkspaceEnvironmentAutomaticRepository(db, () => "2026-08-24T12:00:00.000Z");
    db.prepare("INSERT INTO workspace_environment_setup_gates (thread_id, state, attempt_id, created_at, updated_at) VALUES (?, 'blocked', ?, ?, ?)")
      .run("thread-1", "attempt-corrupt", "2026-08-24T12:00:00.000Z", "2026-08-24T12:00:00.000Z");
    db.prepare("INSERT INTO workspace_environment_automatic_setup_attempts (id, thread_id, state, reason, launch_snapshot_json, created_at) VALUES (?, ?, 'failed', 'setup_failed', ?, ?)")
      .run("attempt-corrupt", "thread-1", "{", "2026-08-24T12:00:00.000Z");

    expect(() => repository.snapshot("thread-1")).toThrow("Invalid persisted automatic Setup launch snapshot");
    expect(prepare).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();

    db.prepare("UPDATE workspace_environment_setup_gates SET state = 'released-by-pass', attempt_id = NULL WHERE thread_id = ?").run("thread-1");
    db.prepare("INSERT INTO messages (id, thread_id, role, content, timestamp, sequence, origin_type, is_internal) VALUES (?, ?, 'user', ?, ?, 1, 'composer', 0)")
      .run("message-corrupt", "thread-1", "Corrupt queued Turn", "2026-08-24T12:00:00.000Z");
    db.prepare("INSERT INTO workspace_environment_queued_turns (id, thread_id, message_id, state, submission_json, created_at, released_at) VALUES (?, ?, ?, 'released', ?, ?, ?)")
      .run("queued-corrupt", "thread-1", "message-corrupt", "{", "2026-08-24T12:00:00.000Z", "2026-08-24T12:00:00.000Z");

    expect(() => repository.claimReleasedTurn("thread-1")).toThrow("Invalid persisted automatic Setup submission");
    expect(service.getAutomaticSetup({ threadId: "thread-1" }).queuedTurns).toMatchObject([
      { id: "queued-corrupt", state: "released" },
    ]);
    expect(prepare).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("settles Continue and reconciliation when a released queued submission is malformed", async () => {
    const { db, service, completion, start } = await automaticHarness();
    const dispatch = vi.fn();
    service.setAutomaticSetupDispatcher({ dispatch });
    service.queueAutomaticFirstTurn(queuedInput());
    await eventually(() => expect(start).toHaveBeenCalledOnce());
    completion.resolve({ kind: "exited", exitCode: 1, output: "failed", outputTruncated: false });
    await eventually(() => expect(service.getAutomaticSetup({ threadId: "thread-1" }).attempt?.state).toBe("failed"));
    db.prepare("UPDATE workspace_environment_queued_turns SET submission_json = ? WHERE thread_id = ?")
      .run("{", "thread-1");

    await expect(service.continueAutomaticSetup({ threadId: "thread-1" })).resolves.toMatchObject({
      gate: "released-by-continue",
      queuedTurns: [{ state: "released" }],
    });
    await expect(service.reconcileAutomaticSetup()).resolves.toBeUndefined();

    expect(dispatch).not.toHaveBeenCalled();
    expect(service.getAutomaticSetup({ threadId: "thread-1" }).queuedTurns).toMatchObject([{ state: "released" }]);
  });

  it("keeps a failed dispatcher claim stable across restart without redispatching", async () => {
    const { root, db, service, completion, start, terminalCommands } = await automaticHarness();
    const failedDispatch = vi.fn().mockRejectedValue(new Error("provider unavailable"));
    service.setAutomaticSetupDispatcher({ dispatch: failedDispatch });
    service.queueAutomaticFirstTurn(queuedInput());
    await eventually(() => expect(start).toHaveBeenCalledOnce());

    completion.resolve({ kind: "exited", exitCode: 0, output: "done", outputTruncated: false });
    await eventually(() => expect(failedDispatch).toHaveBeenCalledOnce());
    expect(service.getAutomaticSetup({ threadId: "thread-1" }).queuedTurns[0]).toMatchObject({ state: "dispatching", dispatchedAt: null });

    const reloaded = new WorkspaceEnvironmentService({
      mcodeDir: root,
      database: db,
      threads: { findById: (id) => id === "thread-1" ? { id, workspace_id: "workspace-1", mode: "worktree", worktree_managed: true } : null },
      terminalCommands,
      platform: "linux",
    });
    const redispatch = vi.fn().mockResolvedValue({ completion: Promise.resolve() });
    reloaded.setAutomaticSetupDispatcher({ dispatch: redispatch });
    await reloaded.reconcileAutomaticSetup();

    expect(redispatch).not.toHaveBeenCalled();
    expect(reloaded.getAutomaticSetup({ threadId: "thread-1" }).queuedTurns[0]).toMatchObject({ state: "dispatching", dispatchedAt: null });
  });

  it("classifies read and preparation failures without leaving a queued attempt unresolved", async () => {
    const readFailure = await automaticHarness();
    vi.spyOn(readFailure.service, "read").mockRejectedValue(new Error("filesystem unavailable"));
    readFailure.service.queueAutomaticFirstTurn(queuedInput());
    await eventually(() => expect(readFailure.service.getAutomaticSetup({ threadId: "thread-1" }).attempt?.state).toBe("failed"));
    expect(readFailure.service.getAutomaticSetup({ threadId: "thread-1" })).toMatchObject({
      gate: "blocked",
      attempt: { reason: "setup_unavailable", outcome: "unavailable" },
      queuedTurns: [{ state: "queued" }],
    });

    const preparationFailure = await automaticHarness({ prepareFailure: true });
    preparationFailure.service.queueAutomaticFirstTurn(queuedInput());
    await eventually(() => expect(preparationFailure.service.getAutomaticSetup({ threadId: "thread-1" }).attempt?.state).toBe("failed"));
    expect(preparationFailure.service.getAutomaticSetup({ threadId: "thread-1" })).toMatchObject({
      gate: "blocked",
      attempt: { reason: "setup_unavailable", outcome: "launch_failure" },
      queuedTurns: [{ state: "queued" }],
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
    const dispatch = vi.fn().mockResolvedValue({ completion: Promise.resolve() });
    reloaded.setAutomaticSetupDispatcher({ dispatch });
    await reloaded.reconcileAutomaticSetup();

    expect(reloaded.getAutomaticSetup({ threadId: "thread-1" })).toMatchObject({
      gate: "blocked",
      attempt: { state: "interrupted", reason: "setup_interrupted" },
      queuedTurns: [{ state: "queued" }],
    });
    expect(start).toHaveBeenCalledOnce();
    completion.resolve({ kind: "exited", exitCode: 0, output: "done", outputTruncated: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("stops a normal closeable automatic Setup command without releasing its queued Turns", async () => {
    const { service, close, start } = await automaticHarness();
    const containment = deferred<{ readonly kind: "contained" }>();
    close.mockImplementationOnce(async () => await containment.promise);
    service.queueAutomaticFirstTurn(queuedInput());
    await eventually(() => expect(start).toHaveBeenCalledOnce());

    const stopping = service.stopAutomaticSetup({ threadId: "thread-1" });
    await eventually(() => expect(close).toHaveBeenCalledOnce());
    let resolved = false;
    void stopping.then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);

    containment.resolve({ kind: "contained" });
    const stopped = await stopping;

    expect(close).toHaveBeenCalledOnce();
    expect(stopped).toMatchObject({
      gate: "blocked",
      attempt: { state: "interrupted", reason: "setup_interrupted" },
      queuedTurns: [{ state: "queued", messageId: "message-1" }],
    });
  });

  it("retries from the current environment into a new immutable automatic Setup snapshot", async () => {
    const { db, service, completion, prepare, start } = await automaticHarness();
    service.queueAutomaticFirstTurn(queuedInput());
    await eventually(() => expect(start).toHaveBeenCalledOnce());
    completion.resolve({ kind: "exited", exitCode: 1, output: "failed", outputTruncated: false });
    await eventually(() => expect(service.getAutomaticSetup({ threadId: "thread-1" }).attempt?.state).toBe("failed"));
    const firstAttemptId = service.getAutomaticSetup({ threadId: "thread-1" }).attempt!.id;

    const revision = (await service.read("workspace-1")).revision;
    await service.save({
      workspaceId: "workspace-1",
      sourceRevision: revision,
      document: { version: "0.0.1", setup: { linux: "bun run setup --fresh" }, actions: [] },
    });
    await service.retryAutomaticSetup({ threadId: "thread-1" });
    await eventually(() => expect(prepare).toHaveBeenCalledTimes(2));

    const retried = service.getAutomaticSetup({ threadId: "thread-1" });
    expect(retried.attempt?.id).not.toBe(firstAttemptId);
    expect(prepare.mock.calls[1]?.[0]).toMatchObject({ script: "bun run setup --fresh" });
    const attempts = db.prepare("SELECT id, launch_snapshot_json FROM workspace_environment_automatic_setup_attempts WHERE thread_id = ? ORDER BY created_at ASC, id ASC")
      .all("thread-1") as Array<{ id: string; launch_snapshot_json: string | null }>;
    expect(attempts).toHaveLength(2);
    expect(JSON.parse(attempts.find((attempt) => attempt.id === firstAttemptId)!.launch_snapshot_json!).script).toBe("bun run setup");
    expect(JSON.parse(attempts.find((attempt) => attempt.id === retried.attempt?.id)!.launch_snapshot_json!).script).toBe("bun run setup --fresh");
  });

  it("waits for Stop to close the prior automatic Setup command before Retry prepares another", async () => {
    const { service, close, prepare, start } = await automaticHarness();
    const closeCompletion = deferred<{ readonly kind: "contained" }>();
    close.mockImplementationOnce(async () => await closeCompletion.promise);
    service.queueAutomaticFirstTurn(queuedInput());
    await eventually(() => expect(start).toHaveBeenCalledOnce());

    const stopping = service.stopAutomaticSetup({ threadId: "thread-1" });
    await eventually(() => expect(close).toHaveBeenCalledOnce());
    const retrying = service.retryAutomaticSetup({ threadId: "thread-1" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(prepare).toHaveBeenCalledOnce();
    closeCompletion.resolve({ kind: "contained" });
    await Promise.all([stopping, retrying]);
    await eventually(() => expect(prepare).toHaveBeenCalledTimes(2));
  });

  it("does not let a Retry requested before Stop prepare a replacement while Stop closes the active command", async () => {
    const { service, close, prepare, start } = await automaticHarness();
    const closeCompletion = deferred<{ readonly kind: "contained" }>();
    close.mockImplementationOnce(async () => await closeCompletion.promise);
    service.queueAutomaticFirstTurn(queuedInput());
    await eventually(() => expect(start).toHaveBeenCalledOnce());

    const retrying = service.retryAutomaticSetup({ threadId: "thread-1" });
    const stopping = service.stopAutomaticSetup({ threadId: "thread-1" });
    await eventually(() => expect(close).toHaveBeenCalledOnce());

    expect(prepare).toHaveBeenCalledOnce();
    closeCompletion.resolve({ kind: "contained" });
    const [, retried] = await Promise.all([stopping, retrying]);

    expect(retried).toMatchObject({ gate: "blocked", attempt: { state: "interrupted" } });
    expect(prepare).toHaveBeenCalledOnce();
  });

  it("blocks Retry after completion containment failure until the command release proves ownership ended", async () => {
    const { service, completion, prepare, start } = await automaticHarness();
    const released = deferred<void>();
    prepare.mockImplementationOnce(async () => ({
      kind: "ready" as const,
      command: {
        snapshot: { checkoutPath: "/project/.worktrees/first", terminal: { executable: "sh", arguments: ["-c", "bun run setup"] } },
        start,
        close: async () => ({ kind: "contained" as const }),
        waitForRelease: async () => await released.promise,
      },
    }));
    service.queueAutomaticFirstTurn(queuedInput());
    await eventually(() => expect(start).toHaveBeenCalledOnce());

    completion.resolve({ kind: "containment_failure", output: "orphaned process", outputTruncated: false });
    await eventually(() => expect(service.getAutomaticSetup({ threadId: "thread-1" }).attempt?.outcome).toBe("containment_failure"));

    await expect(service.retryAutomaticSetup({ threadId: "thread-1" })).rejects.toMatchObject({
      code: "WORKSPACE_ENVIRONMENT_SETUP_UNAVAILABLE",
    });
    expect(prepare).toHaveBeenCalledOnce();

    released.resolve();
    await service.retryAutomaticSetup({ threadId: "thread-1" });
    await eventually(() => expect(prepare).toHaveBeenCalledTimes(2));
  });

  it("closes containment-completed automatic commands during deletion and disposal after their attempt is final", async () => {
    const actions = [
      async (service: WorkspaceEnvironmentService) => {
        const releaseDeletion = service.beginThreadDeletion("thread-1");
        try {
          await service.cancelSetupForThread("thread-1");
        } finally {
          releaseDeletion();
        }
      },
      async (service: WorkspaceEnvironmentService) => await service.dispose(),
    ];

    for (const action of actions) {
      const { service, completion, close, start } = await automaticHarness();
      service.queueAutomaticFirstTurn(queuedInput());
      await eventually(() => expect(start).toHaveBeenCalledOnce());
      completion.resolve({ kind: "containment_failure", output: "orphaned process", outputTruncated: false });
      await eventually(() => expect(service.getAutomaticSetup({ threadId: "thread-1" }).attempt?.outcome).toBe("containment_failure"));

      await action(service);
      expect(close).toHaveBeenCalledOnce();
    }
  });

  it("keeps automatic Setup ownership after containment failure and rejects Retry and disposal", async () => {
    const { service, close, prepare, start } = await automaticHarness();
    close.mockResolvedValueOnce({ kind: "containment_failure" });
    service.queueAutomaticFirstTurn(queuedInput());
    await eventually(() => expect(start).toHaveBeenCalledOnce());

    await expect(service.stopAutomaticSetup({ threadId: "thread-1" })).rejects.toThrow("Automatic Project Setup process containment failed");
    await expect(service.retryAutomaticSetup({ threadId: "thread-1" })).rejects.toThrow("Automatic Project Setup process containment failed");
    await expect(service.dispose()).rejects.toThrow("Automatic Project Setup process containment failed");

    expect(prepare).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
  });

  it("joins a pending Stop close before Thread deletion, workspace deletion, or disposal returns", async () => {
    const actions = [
      async (service: WorkspaceEnvironmentService) => {
        const release = service.beginThreadDeletion("thread-1");
        try {
          await service.cancelSetupForThread("thread-1");
        } finally {
          release();
        }
      },
      async (service: WorkspaceEnvironmentService) => {
        const release = service.beginWorkspaceDeletion("workspace-1");
        try {
          await service.cancelSetupForWorkspace("workspace-1");
        } finally {
          release();
        }
      },
      async (service: WorkspaceEnvironmentService) => await service.dispose(),
    ];

    for (const action of actions) {
      const { service, close, start } = await automaticHarness();
      const closeCompletion = deferred<{ readonly kind: "contained" }>();
      close.mockImplementationOnce(async () => await closeCompletion.promise);
      service.queueAutomaticFirstTurn(queuedInput());
      await eventually(() => expect(start).toHaveBeenCalledOnce());

      const stopping = service.stopAutomaticSetup({ threadId: "thread-1" });
      await eventually(() => expect(close).toHaveBeenCalledOnce());
      const cancelling = action(service);
      let returned = false;
      void cancelling.then(() => { returned = true; });
      await Promise.resolve();
      expect(returned).toBe(false);

      closeCompletion.resolve({ kind: "contained" });
      await Promise.all([stopping, cancelling]);
    }
  });

  it("rejects Continue after concurrent deletion and joins its accepted drain before cleanup returns", async () => {
    const { service, completion, start } = await automaticHarness();
    const accepted = deferred<{ readonly completion: Promise<void> }>();
    const firstTurnCompletion = deferred<void>();
    const dispatch = vi.fn(async () => await accepted.promise);
    service.setAutomaticSetupDispatcher({ dispatch });
    service.queueAutomaticFirstTurn(queuedInput());
    await eventually(() => expect(start).toHaveBeenCalledOnce());
    completion.resolve({ kind: "exited", exitCode: 1, output: "failed", outputTruncated: false });
    await eventually(() => expect(service.getAutomaticSetup({ threadId: "thread-1" }).attempt?.state).toBe("failed"));

    const continuing = service.continueAutomaticSetup({ threadId: "thread-1" });
    await eventually(() => expect(dispatch).toHaveBeenCalledOnce());
    const releaseDeletion = service.beginThreadDeletion("thread-1");
    const deleting = service.cancelSetupForThread("thread-1");
    accepted.resolve({ completion: firstTurnCompletion.promise });

    await expect(continuing).rejects.toMatchObject({ code: "WORKSPACE_ENVIRONMENT_SETUP_UNAVAILABLE" });
    let deleted = false;
    void deleting.then(() => { deleted = true; });
    await Promise.resolve();
    expect(deleted).toBe(false);

    firstTurnCompletion.resolve();
    await deleting;
    releaseDeletion();
  });

  it("rejects Retry after its pending Stop close completes during Thread deletion", async () => {
    const { service, close, prepare, start } = await automaticHarness();
    const closeCompletion = deferred<{ readonly kind: "contained" }>();
    close.mockImplementationOnce(async () => await closeCompletion.promise);
    service.queueAutomaticFirstTurn(queuedInput());
    await eventually(() => expect(start).toHaveBeenCalledOnce());

    const stopping = service.stopAutomaticSetup({ threadId: "thread-1" });
    await eventually(() => expect(close).toHaveBeenCalledOnce());
    const retrying = service.retryAutomaticSetup({ threadId: "thread-1" });
    const releaseDeletion = service.beginThreadDeletion("thread-1");
    closeCompletion.resolve({ kind: "contained" });

    await stopping;
    await expect(retrying).rejects.toMatchObject({ code: "WORKSPACE_ENVIRONMENT_SETUP_UNAVAILABLE" });
    expect(prepare).toHaveBeenCalledOnce();
    releaseDeletion();
  });

  it("opens a recovery Terminal without resuming Setup or releasing its gate", async () => {
    const { service, start, terminalRecovery } = await automaticHarness();
    service.queueAutomaticFirstTurn(queuedInput());
    await eventually(() => expect(start).toHaveBeenCalledOnce());
    const before = service.getAutomaticSetup({ threadId: "thread-1" });

    await expect(service.openAutomaticSetupTerminal({ threadId: "thread-1" })).resolves.toEqual({ ptyId: "recovery-pty", shell: "sh" });

    expect(terminalRecovery.create).toHaveBeenCalledWith("thread-1");
    expect(service.getAutomaticSetup({ threadId: "thread-1" })).toEqual(before);
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

  it("preserves a Continue release without recording Setup as passed", async () => {
    const { root, db, service, start, completion, terminalCommands } = await automaticHarness();
    service.queueAutomaticFirstTurn(queuedInput());
    await eventually(() => expect(start).toHaveBeenCalledOnce());
    completion.resolve({ kind: "exited", exitCode: 1, output: "failed", outputTruncated: false });
    await eventually(() => expect(service.getAutomaticSetup({ threadId: "thread-1" }).attempt?.state).toBe("failed"));
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
      attempt: { state: "failed", reason: "setup_failed" },
      queuedTurns: [{ state: "released", dispatchedAt: null }],
    });
  });
});
