import "reflect-metadata";
import * as NodeFSPromises from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { createAgentServiceForTest } from "./agent-service-test-harness.js";
import { WorkspaceEnvironmentService } from "../../../projects/environment/workspace-environment-service.js";
import { createCanonicalAgentEventSinkStub } from "../../canonical/__tests__/canonical-agent-event-sink-stub.js";
import type { GitService } from "../../../projects/index.js";
import type { ThreadService } from "../../../thread-control/index.js";
import { ParentAssistantTextCheckpointService } from "../../turns/parent-assistant-text-checkpoint-service.js";
import { NarrativeStore } from "../../conversation/narrative/narrative-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => NodeFSPromises.rm(root, { recursive: true, force: true })));
});

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

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function createAgentServiceHarness(automaticSetup?:
  | { queueAutomaticFirstTurn: ReturnType<typeof vi.fn>; admitAutomaticTurn?: ReturnType<typeof vi.fn> }
  | ((deps: { readonly db: Database.Database; readonly threadRepo: ThreadRepo }) => WorkspaceEnvironmentService),
) {
  const db: Database.Database = openMemoryDatabase();
  const threadRepo = new ThreadRepo(db);
  const workspaceRepo = new WorkspaceRepo(db);
  const messageRepo = new MessageRepo(db);
  const gitService = {
    listWorktrees: vi.fn(),
    resolveWorkingDir: vi.fn(() => process.cwd()),
  } as unknown as GitService;
  const threadService = {
    create: vi.fn(),
  } as unknown as ThreadService;
  const availability = { assertUsable: vi.fn() };
  const provider = {
    id: "claude" as const,
    sendTurn: vi.fn(async () => undefined),
    stopSession: vi.fn(async () => undefined),
  };
  const providerRegistry = {
    resolve: vi.fn(() => provider),
    resolveAll: vi.fn(() => [provider]),
  };
  const attachmentService = {
    persist: vi.fn(async () => ({ stored: [], persisted: [] })),
    removeStoredAttachments: vi.fn(async () => undefined),
  };
  const goals = { routeCommand: vi.fn(async () => ({ kind: "passthrough" as const })) };
  const resolvedAutomaticSetup = typeof automaticSetup === "function"
    ? automaticSetup({ db, threadRepo })
    : automaticSetup;
  const service = createAgentServiceForTest(
    threadRepo,
    workspaceRepo,
    messageRepo,
    gitService,
    attachmentService as never,
    providerRegistry as never,
    threadService,
    {} as never,
    {} as never,
    {
      captureRef: vi.fn(async () => "ref-before"),
      getFilesChanged: vi.fn(async () => []),
    } as never,
    db,
    {
      markActive: vi.fn(),
      markIdle: vi.fn(),
      assertCanStartTurn: vi.fn(),
      onPressureChange: vi.fn(),
    } as never,
    {
      get: vi.fn(() => ({
        model: { defaults: { fallbackId: undefined } },
        agent: { guardrails: { maxBudgetUsd: 0, maxTurns: 0 } },
      })),
    } as never,
    availability as never,
    {} as never,
    {} as never,
    {} as never,
    new NarrativeStore(
      messageRepo,
      { bulkCreate: vi.fn(), bulkCreateBatched: vi.fn() } as never,
      { bulkCreate: vi.fn(), bulkCreateBatched: vi.fn() } as never,
      { bulkCreate: vi.fn(), bulkCreateBatched: vi.fn() } as never,
    ),
    new ParentAssistantTextCheckpointService(db),
    {} as never,
    undefined,
    undefined,
    createCanonicalAgentEventSinkStub(db),
    resolvedAutomaticSetup as never,
    undefined,
    undefined,
    goals as never,
    undefined,
    undefined,
    undefined,
  );
  return {
    db,
    threadRepo,
    workspaceRepo,
    messageRepo,
    gitService,
    threadService,
    service,
    provider,
    availability,
    attachmentService,
    goals,
    automaticSetup: resolvedAutomaticSetup,
  };
}

describe("AgentService.createAndSend defaults", () => {
  it("queues only the first Turn for a managed New worktree before AgentService reserves runtime state", async () => {
    const automaticSetup = { queueAutomaticFirstTurn: vi.fn(), admitAutomaticTurn: vi.fn(() => ({ queued: true })) };
    const { threadRepo, workspaceRepo, threadService, service, provider } = createAgentServiceHarness(automaticSetup);
    const workspace = workspaceRepo.create("Repo", "/repo");
    const managed = threadRepo.create(workspace.id, "Managed first Turn", "worktree", "feature/managed", true, "claude");
    vi.mocked(threadService.create).mockResolvedValue(managed);

    const result = await service.createAndSend({
      workspaceId: workspace.id,
      content: "Queue this first Turn",
      mode: "worktree",
      branch: "feature/managed",
    });

    expect(automaticSetup.admitAutomaticTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: managed.id,
      content: "Queue this first Turn",
      submission: expect.objectContaining({ messageId: expect.any(String) }),
    }));
    expect(provider.sendTurn).not.toHaveBeenCalled();
    expect(result.runtimeSnapshot).toEqual({ threadId: managed.id, turnExecutionId: null, phase: "idle" });
  });

  it("dispatches a managed New first Turn without Continue when the workspace has no Setup", async () => {
    const root = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-agent-automatic-setup-"));
    roots.push(root);
    const prepare = vi.fn();
    const { threadRepo, workspaceRepo, threadService, service, provider, automaticSetup } = createAgentServiceHarness(({ db, threadRepo: threads }) =>
      new WorkspaceEnvironmentService({
        mcodeDir: root,
        database: db,
        threads: { findById: (id) => threads.findById(id) },
        terminalCommands: { prepare },
        platform: "linux",
      }),
    );
    const workspace = workspaceRepo.create("Repo", "/repo");
    const managed = threadRepo.create(workspace.id, "Managed first Turn", "worktree", "feature/managed", true, "claude");
    vi.mocked(threadService.create).mockResolvedValue(managed);
    const providerCompletion = deferred<void>();
    provider.sendTurn.mockImplementation(async () => await providerCompletion.promise);
    const environment = automaticSetup as WorkspaceEnvironmentService;
    environment.setAutomaticSetupDispatcher({ dispatch: (submission) => service.dispatchQueuedAutomaticTurn(submission) });

    await service.createAndSend({
      workspaceId: workspace.id,
      content: "Dispatch without Setup",
      mode: "worktree",
      branch: "feature/managed",
    });

    await eventually(() => expect(provider.sendTurn).toHaveBeenCalledOnce());
    expect(prepare).not.toHaveBeenCalled();
    expect(environment.getAutomaticSetup({ threadId: managed.id })).toMatchObject({
      gate: "not-required",
      attempt: null,
      queuedTurns: [{ state: "dispatched", dispatchedAt: expect.any(String) }],
    });
    providerCompletion.resolve();
  });

  it("persists each later Turn sent while automatic Setup remains blocked", async () => {
    const root = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-agent-queued-turn-"));
    roots.push(root);
    const { db, threadRepo, workspaceRepo, service, automaticSetup } = createAgentServiceHarness(({ db, threadRepo: threads }) =>
      new WorkspaceEnvironmentService({
        mcodeDir: root,
        database: db,
        threads: { findById: (id) => threads.findById(id) },
        terminalCommands: {
          prepare: async () => ({
            kind: "ready" as const,
            command: {
              snapshot: { checkoutPath: "/repo/.worktrees/managed", terminal: { executable: "sh", arguments: ["-c", "bun run setup"] } },
              start: async () => await new Promise<never>(() => undefined),
              close: async () => ({ kind: "contained" as const }),
              waitForRelease: async () => await new Promise<never>(() => undefined),
            },
          }),
        },
        platform: "linux",
      }),
    );
    const workspace = workspaceRepo.create("Repo", "/repo");
    const managed = threadRepo.create(workspace.id, "Managed", "worktree", "feature/managed", true, "claude");
    const environment = automaticSetup as WorkspaceEnvironmentService;
    await environment.save({
      workspaceId: workspace.id,
      sourceRevision: null,
      document: { version: "0.0.1", setup: { linux: "bun run setup" }, actions: [] },
    });
    environment.queueAutomaticFirstTurn({
      threadId: managed.id,
      messageId: "message-first",
      content: "First blocked Turn",
      attachments: [],
      mentions: [],
      submission: {
        threadId: managed.id,
        messageId: "message-first",
        content: "First blocked Turn",
        displayContent: "First blocked Turn",
        model: "claude-sonnet-4-6",
        permissionMode: "default",
        attachments: [],
        persistedAttachments: [],
        mentions: [],
        provider: "claude",
      },
    });

    await service.sendMessage({ threadId: managed.id, content: "Second blocked Turn" });

    expect(environment.getAutomaticSetup({ threadId: managed.id }).queuedTurns).toHaveLength(2);
    expect(environment.getAutomaticSetup({ threadId: managed.id }).queuedTurns).toEqual(expect.arrayContaining([
      expect.objectContaining({ messageId: "message-first", state: "queued" }),
      expect.objectContaining({ state: "queued" }),
    ]));
    expect(db.prepare("SELECT content FROM messages WHERE thread_id = ? ORDER BY sequence").all(managed.id)).toEqual([
      { content: "First blocked Turn" },
      { content: "Second blocked Turn" },
    ]);
  });

  it("removes newly persisted attachments when the automatic queue is at capacity", async () => {
    const root = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-agent-queued-turn-capacity-"));
    roots.push(root);
    const { threadRepo, workspaceRepo, service, attachmentService, automaticSetup } = createAgentServiceHarness(({ db, threadRepo: threads }) =>
      new WorkspaceEnvironmentService({
        mcodeDir: root,
        database: db,
        threads: { findById: (id) => threads.findById(id) },
        terminalCommands: { prepare: vi.fn() },
        platform: "linux",
      }),
    );
    const workspace = workspaceRepo.create("Repo", "/repo");
    const managed = threadRepo.create(workspace.id, "Managed", "worktree", "feature/managed", true, "claude");
    const environment = automaticSetup as WorkspaceEnvironmentService;
    await environment.save({
      workspaceId: workspace.id,
      sourceRevision: null,
      document: { version: "0.0.1", setup: { linux: "bun run setup" }, actions: [] },
    });
    for (let index = 1; index <= 64; index += 1) {
      environment.queueAutomaticFirstTurn({
        threadId: managed.id,
        messageId: `queued-capacity-${index}`,
        content: `Queued Turn ${index}`,
        attachments: [],
        mentions: [],
        submission: {
          threadId: managed.id,
          messageId: `queued-capacity-${index}`,
          content: `Queued Turn ${index}`,
          displayContent: `Queued Turn ${index}`,
          model: "claude-sonnet-4-6",
          permissionMode: "default",
          attachments: [],
          persistedAttachments: [],
          mentions: [],
          provider: "claude",
        },
      });
    }
    const stored = { id: "attachment-capacity", name: "capacity.png", mimeType: "image/png", sizeBytes: 4 };
    attachmentService.persist.mockResolvedValue({
      stored: [stored],
      persisted: [{ ...stored, sourcePath: "/tmp/capacity.png" }],
    });

    await expect(service.sendMessage({
      threadId: managed.id,
      content: "Overflow queued Turn",
      attachments: [{ ...stored, sourcePath: "/tmp/source-capacity.png" }],
    })).rejects.toMatchObject({ code: "WORKSPACE_ENVIRONMENT_SETUP_CAPACITY" });

    expect(attachmentService.removeStoredAttachments).toHaveBeenCalledWith(managed.id, [stored]);
  });

  it("removes newly persisted attachments when Thread deletion rejects automatic admission", async () => {
    const root = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-agent-queued-turn-deletion-"));
    roots.push(root);
    const { threadRepo, workspaceRepo, service, attachmentService, automaticSetup } = createAgentServiceHarness(({ db, threadRepo: threads }) =>
      new WorkspaceEnvironmentService({
        mcodeDir: root,
        database: db,
        threads: { findById: (id) => threads.findById(id) },
        terminalCommands: { prepare: vi.fn() },
        platform: "linux",
      }),
    );
    const workspace = workspaceRepo.create("Repo", "/repo");
    const managed = threadRepo.create(workspace.id, "Managed", "worktree", "feature/managed", true, "claude");
    const environment = automaticSetup as WorkspaceEnvironmentService;
    await environment.save({
      workspaceId: workspace.id,
      sourceRevision: null,
      document: { version: "0.0.1", setup: { linux: "bun run setup" }, actions: [] },
    });
    environment.queueAutomaticFirstTurn({
      threadId: managed.id,
      messageId: "queued-deletion-1",
      content: "First blocked Turn",
      attachments: [],
      mentions: [],
      submission: {
        threadId: managed.id,
        messageId: "queued-deletion-1",
        content: "First blocked Turn",
        displayContent: "First blocked Turn",
        model: "claude-sonnet-4-6",
        permissionMode: "default",
        attachments: [],
        persistedAttachments: [],
        mentions: [],
        provider: "claude",
      },
    });
    const stored = { id: "attachment-deletion", name: "deletion.png", mimeType: "image/png", sizeBytes: 4 };
    attachmentService.persist.mockResolvedValue({
      stored: [stored],
      persisted: [{ ...stored, sourcePath: "/tmp/deletion.png" }],
    });
    const releaseDeletion = environment.beginThreadDeletion(managed.id);

    await expect(service.sendMessage({
      threadId: managed.id,
      content: "Rejected by deletion",
      attachments: [{ ...stored, sourcePath: "/tmp/source-deletion.png" }],
    })).rejects.toMatchObject({ code: "WORKSPACE_ENVIRONMENT_SETUP_UNAVAILABLE" });

    expect(attachmentService.removeStoredAttachments).toHaveBeenCalledWith(managed.id, [stored]);
    releaseDeletion();
  });

  it("cleans released-gate attachments when a native command handles the send without persisting a Turn", async () => {
    const root = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-agent-queued-turn-handled-"));
    roots.push(root);
    const { threadRepo, workspaceRepo, messageRepo, service, attachmentService, goals, automaticSetup } = createAgentServiceHarness(({ db, threadRepo: threads }) =>
      new WorkspaceEnvironmentService({
        mcodeDir: root,
        database: db,
        threads: { findById: (id) => threads.findById(id) },
        terminalCommands: { prepare: async () => { throw new Error("setup unavailable"); } },
        platform: "linux",
      }),
    );
    const workspace = workspaceRepo.create("Repo", "/repo");
    const managed = threadRepo.create(workspace.id, "Managed", "worktree", "feature/managed", true, "claude");
    const environment = automaticSetup as WorkspaceEnvironmentService;
    await environment.save({
      workspaceId: workspace.id,
      sourceRevision: null,
      document: { version: "0.0.1", setup: { linux: "bun run setup" }, actions: [] },
    });
    environment.queueAutomaticFirstTurn({
      threadId: managed.id,
      messageId: "message-first",
      content: "First blocked Turn",
      attachments: [],
      mentions: [],
      submission: {
        threadId: managed.id,
        messageId: "message-first",
        content: "First blocked Turn",
        displayContent: "First blocked Turn",
        model: "claude-sonnet-4-6",
        permissionMode: "default",
        attachments: [],
        persistedAttachments: [],
        mentions: [],
        provider: "claude",
      },
    });
    await eventually(() => expect(environment.getAutomaticSetup({ threadId: managed.id }).attempt?.state).toBe("failed"));
    const stored = { id: "attachment-handled", name: "handled.png", mimeType: "image/png", sizeBytes: 4 };
    attachmentService.persist.mockImplementationOnce(async () => {
      await environment.continueAutomaticSetup({ threadId: managed.id });
      return { stored: [stored], persisted: [{ ...stored, sourcePath: "/tmp/handled.png" }] };
    });
    goals.routeCommand.mockResolvedValueOnce({ kind: "handled" });

    await service.sendMessage({
      threadId: managed.id,
      content: "handled command after release",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      provider: "claude",
      attachments: [{ ...stored, sourcePath: "/tmp/source-handled.png" }],
    });

    expect(attachmentService.removeStoredAttachments).toHaveBeenCalledWith(managed.id, [stored]);
    expect(messageRepo.listByThread(managed.id, 100).messages.map((message) => message.content)).not.toContain("handled command after release");
  });

  it("replays a blocked reply with its plan and provenance fields exactly as queued", async () => {
    const root = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mcode-agent-queued-turn-fidelity-"));
    roots.push(root);
    const { db, threadRepo, workspaceRepo, messageRepo, service, automaticSetup } = createAgentServiceHarness(({ db, threadRepo: threads }) =>
      new WorkspaceEnvironmentService({
        mcodeDir: root,
        database: db,
        threads: { findById: (id) => threads.findById(id) },
        terminalCommands: { prepare: vi.fn() },
        platform: "linux",
      }),
    );
    const workspace = workspaceRepo.create("Repo", "/repo");
    const managed = threadRepo.create(workspace.id, "Managed", "worktree", "feature/managed", true, "claude");
    const replyTarget = messageRepo.create(managed.id, "assistant", "Prior answer", 1);
    const environment = automaticSetup as WorkspaceEnvironmentService;
    await environment.save({
      workspaceId: workspace.id,
      sourceRevision: null,
      document: { version: "0.0.1", setup: { linux: "bun run setup" }, actions: [] },
    });
    environment.queueAutomaticFirstTurn({
      threadId: managed.id,
      messageId: "message-first",
      content: "First blocked Turn",
      attachments: [],
      mentions: [],
      submission: {
        threadId: managed.id,
        messageId: "message-first",
        content: "First blocked Turn",
        displayContent: "First blocked Turn",
        model: "claude-sonnet-4-6",
        permissionMode: "default",
        attachments: [],
        persistedAttachments: [],
        mentions: [],
        provider: "claude",
      },
    });

    await service.sendMessage({
      threadId: managed.id,
      content: "Queued reply",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      provider: "claude",
      attachments: [],
      replyToMessageId: replyTarget.id,
      quotedText: "The precise quoted passage",
      planAction: "implement",
      markPlanAnswerForMessageId: "00000000-0000-4000-8000-000000000001",
      sourceTurnId: "00000000-0000-4000-8000-000000000002",
      sourceThreadId: "source-thread",
      sourceProviderId: "codex",
      originSourceTurnId: "00000000-0000-4000-8000-000000000003",
    });

    const queued = db.prepare(
      "SELECT q.submission_json, m.id, m.reply_to_message_id, m.quoted_text, m.origin_type, m.source_thread_id, m.source_turn_id, m.source_provider_id FROM workspace_environment_queued_turns q JOIN messages m ON m.id = q.message_id WHERE q.thread_id = ? AND m.content = ?",
    ).get(managed.id, "Queued reply") as {
      submission_json: string;
      id: string;
      reply_to_message_id: string | null;
      quoted_text: string | null;
      origin_type: string;
      source_thread_id: string | null;
      source_turn_id: string | null;
      source_provider_id: string | null;
    };
    expect(queued).toMatchObject({
      reply_to_message_id: replyTarget.id,
      quoted_text: "The precise quoted passage",
      origin_type: "thread",
      source_thread_id: "source-thread",
      source_turn_id: "00000000-0000-4000-8000-000000000003",
      source_provider_id: "codex",
    });
    const persisted = JSON.parse(queued.submission_json) as Record<string, unknown>;
    expect(persisted).toMatchObject({
      replyToMessageId: replyTarget.id,
      quotedText: "The precise quoted passage",
      planAction: "implement",
      markPlanAnswerForMessageId: "00000000-0000-4000-8000-000000000001",
      sourceTurnId: "00000000-0000-4000-8000-000000000002",
      sourceThreadId: "source-thread",
      sourceProviderId: "codex",
      originSourceTurnId: "00000000-0000-4000-8000-000000000003",
    });

  });

  it("keeps Direct and Existing worktree first Turns on immediate dispatch", async () => {
    const automaticSetup = { queueAutomaticFirstTurn: vi.fn(), admitAutomaticTurn: vi.fn(() => ({ queued: true })) };
    const { workspaceRepo, gitService, service, provider } = createAgentServiceHarness(automaticSetup);
    const workspace = workspaceRepo.create("Repo", "/repo");
    vi.mocked(gitService.listWorktrees).mockResolvedValue([
      { path: "/repo/.worktrees/existing", branch: "feature/existing" },
    ] as never);

    await service.createAndSend({ workspaceId: workspace.id, content: "Direct dispatch" });
    await service.createAndSend({
      workspaceId: workspace.id,
      content: "Existing dispatch",
      mode: "worktree",
      existingWorktreePath: "/repo/.worktrees/existing",
    });

    expect(automaticSetup.queueAutomaticFirstTurn).not.toHaveBeenCalled();
    await eventually(() => expect(provider.sendTurn).toHaveBeenCalledTimes(2));
  });

  it("returns the authoritative running runtime snapshot after startup", async () => {
    const { workspaceRepo, service } = createAgentServiceHarness();
    const workspace = workspaceRepo.create("Repo", "/repo");

    const result = await service.createAndSend({
      workspaceId: workspace.id,
      content: "Start the first turn",
    });

    expect(result.runtimeSnapshot).toMatchObject({
      threadId: result.id,
      phase: "running",
    });
    expect(result.runtimeSnapshot.turnExecutionId).toEqual(expect.any(String));
  });

  it("returns an idle snapshot when startup fails before runtime ownership", async () => {
    const { workspaceRepo, service, availability } = createAgentServiceHarness();
    const workspace = workspaceRepo.create("Repo", "/repo");
    availability.assertUsable.mockImplementation(() => {
      throw new Error("startup failed");
    });

    const result = await service.createAndSend({
      workspaceId: workspace.id,
      content: "Start the first turn",
    });

    expect(result.runtimeSnapshot).toEqual({
      threadId: result.id,
      turnExecutionId: null,
      phase: "idle",
    });
  });

  it("returns after runtime startup without waiting for provider completion", async () => {
    const { workspaceRepo, service, provider } = createAgentServiceHarness();
    const workspace = workspaceRepo.create("Repo", "/repo");
    let finishProvider!: () => void;
    const providerDone = new Promise<void>((resolve) => {
      finishProvider = resolve;
    });
    provider.sendTurn.mockImplementation(async () => await providerDone);

    const result = await service.createAndSend({
      workspaceId: workspace.id,
      content: "Start without waiting",
    });

    expect(result.runtimeSnapshot.phase).toBe("running");
    finishProvider();
  });

  it("uses the default model when the command omits it", async () => {
    const { threadRepo, workspaceRepo, service, provider } = createAgentServiceHarness();
    const workspace = workspaceRepo.create("Repo", "/repo");

    const thread = await service.createAndSend({
      workspaceId: workspace.id,
      content: "Use the default model",
    });

    expect(thread.model).toBe("claude-sonnet-4-6");
    expect(threadRepo.findById(thread.id)?.model).toBe("claude-sonnet-4-6");
    await eventually(() => expect(provider.sendTurn).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: `mcode-${thread.id}`,
      model: "claude-sonnet-4-6",
    })));
  });
});

describe("AgentService.createAndSend existing worktree attach", () => {
  it("creates a new worktree as branchless from the selected base branch", async () => {
    const { threadRepo, workspaceRepo, threadService, service } = createAgentServiceHarness();
    const workspace = workspaceRepo.create("Repo", "/repo");
    const createdThread = {
      ...threadRepo.create(
        workspace.id,
        "Work from feature base",
        "worktree",
        "feature/base",
        true,
        "claude",
        undefined,
        "branchless",
        "feature/base",
      ),
      worktree_path: "/repo/.worktrees/feature-base",
    };
    vi.mocked(threadService.create).mockResolvedValue(createdThread);

    const thread = await service.createAndSend({
      workspaceId: workspace.id,
      content: "Work from feature base",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      mode: "worktree",
      branch: "feature/base",
    });

    expect(threadService.create).toHaveBeenCalledWith(
      workspace.id,
      "Work from feature base",
      "worktree",
      "feature/base",
      { branchless: true },
    );
    expect(thread).toMatchObject({
      mode: "worktree",
      branch: "feature/base",
      checkout_state: "branchless",
      base_branch: "feature/base",
    });
  });

  it("creates a new worktree on a PR branch as a named checkout", async () => {
    const { threadRepo, workspaceRepo, threadService, service } = createAgentServiceHarness();
    const workspace = workspaceRepo.create("Repo", "/repo");
    const createdThread = {
      ...threadRepo.create(
        workspace.id,
        "Review PR",
        "worktree",
        "contributor/pr-branch",
        true,
        "claude",
        undefined,
        "named",
        null,
      ),
      worktree_path: "/repo/.worktrees/contributor-pr-branch",
    };
    vi.mocked(threadService.create).mockResolvedValue(createdThread);

    const thread = await service.createAndSend({
      workspaceId: workspace.id,
      content: "Review PR",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      mode: "worktree",
      branch: "contributor/pr-branch",
      worktreeBranchMode: "named",
    });

    expect(threadService.create).toHaveBeenCalledWith(
      workspace.id,
      "Review PR",
      "worktree",
      "contributor/pr-branch",
      { branchless: false },
    );
    expect(thread).toMatchObject({
      mode: "worktree",
      branch: "contributor/pr-branch",
      checkout_state: "named",
      base_branch: null,
    });
  });

  it("attaches a detached existing worktree as branchless with the selected base branch", async () => {
    const { workspaceRepo, gitService, service } = createAgentServiceHarness();
    const workspace = workspaceRepo.create("Repo", "/repo");
    vi.mocked(gitService.listWorktrees).mockResolvedValue([
      {
        name: "branchless-existing",
        path: "/repo/.worktrees/branchless-existing",
        branch: "(detached)",
        managed: true,
      },
    ]);

    const thread = await service.createAndSend({
      workspaceId: workspace.id,
      content: "Work in detached worktree",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      mode: "worktree",
      branch: "main",
      existingWorktreePath: "/repo/.worktrees/branchless-existing/",
      existingWorktreeBaseBranch: "main",
      attachments: [],
      provider: "claude",
    });

    expect(thread).toMatchObject({
      mode: "worktree",
      worktree_path: "/repo/.worktrees/branchless-existing",
      branch: "main",
      checkout_state: "branchless",
      base_branch: "main",
      worktree_managed: false,
    });
  });

  it("keeps named existing worktree attach behavior unchanged", async () => {
    const { workspaceRepo, gitService, service } = createAgentServiceHarness();
    const workspace = workspaceRepo.create("Repo", "/repo");
    vi.mocked(gitService.listWorktrees).mockResolvedValue([
      {
        name: "feature-existing",
        path: "/repo/.worktrees/feature-existing",
        branch: "feat/existing",
        managed: true,
      },
    ]);

    const thread = await service.createAndSend({
      workspaceId: workspace.id,
      content: "Work in named worktree",
      model: "claude-sonnet-4-6",
      permissionMode: "default",
      mode: "worktree",
      branch: "main",
      existingWorktreePath: "/repo/.worktrees/feature-existing",
      attachments: [],
      provider: "claude",
    });

    expect(thread).toMatchObject({
      mode: "worktree",
      worktree_path: "/repo/.worktrees/feature-existing",
      branch: "feat/existing",
      checkout_state: "named",
      base_branch: null,
      worktree_managed: false,
    });
  });

  it("rejects HEAD as the base branch for detached existing worktrees", async () => {
    const { workspaceRepo, gitService, service } = createAgentServiceHarness();
    const workspace = workspaceRepo.create("Repo", "/repo");
    vi.mocked(gitService.listWorktrees).mockResolvedValue([
      {
        name: "branchless-existing",
        path: "/repo/.worktrees/branchless-existing",
        branch: "(detached)",
        managed: true,
      },
    ]);

    await expect(
      service.createAndSend({
        workspaceId: workspace.id,
        content: "Work in detached worktree",
        model: "claude-sonnet-4-6",
        permissionMode: "default",
        mode: "worktree",
        branch: "main",
        existingWorktreePath: "/repo/.worktrees/branchless-existing",
        existingWorktreeBaseBranch: "HEAD",
        attachments: [],
        provider: "claude",
      }),
    ).rejects.toThrow("Base branch cannot be HEAD");
  });
});
