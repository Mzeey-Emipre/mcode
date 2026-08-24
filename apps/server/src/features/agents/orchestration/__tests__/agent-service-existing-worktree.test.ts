import "reflect-metadata";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { AgentService } from "../agent-service.js";
import { WorkspaceEnvironmentService } from "../../../projects/environment/workspace-environment-service.js";
import { createCanonicalAgentEventSinkStub } from "../../canonical/__tests__/canonical-agent-event-sink-stub.js";
import type { GitService } from "../../../projects/index.js";
import type { ThreadService } from "../../../thread-control/index.js";
import type { TurnRuntimeSnapshot } from "@mcode/contracts";
import { ParentAssistantTextCheckpointService } from "../../turns/parent-assistant-text-checkpoint-service.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
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
  | { queueAutomaticFirstTurn: ReturnType<typeof vi.fn> }
  | ((deps: { readonly db: Database.Database; readonly threadRepo: ThreadRepo }) => WorkspaceEnvironmentService),
) {
  const db: Database.Database = openMemoryDatabase();
  const threadRepo = new ThreadRepo(db);
  const workspaceRepo = new WorkspaceRepo(db);
  const messageRepo = new MessageRepo(db);
  const gitService = {
    listWorktrees: vi.fn(),
  } as unknown as GitService;
  const threadService = {
    create: vi.fn(),
  } as unknown as ThreadService;
  const resolvedAutomaticSetup = typeof automaticSetup === "function"
    ? automaticSetup({ db, threadRepo })
    : automaticSetup;
  const service = new AgentService(
    threadRepo,
    workspaceRepo,
    messageRepo,
    gitService,
    { persist: vi.fn(async () => ({ stored: [], persisted: [] })) } as never,
    {} as never,
    threadService,
    {} as never,
    {} as never,
    {} as never,
    db,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    new ParentAssistantTextCheckpointService(db),
    {} as never,
    undefined,
    undefined,
    createCanonicalAgentEventSinkStub(db),
    resolvedAutomaticSetup as never,
  );
  vi.spyOn(service, "sendMessage").mockResolvedValue(undefined);

  return { db, threadRepo, workspaceRepo, messageRepo, gitService, threadService, service, automaticSetup: resolvedAutomaticSetup };
}

describe("AgentService.createAndSend defaults", () => {
  it("queues only the first Turn for a managed New worktree before AgentService reserves runtime state", async () => {
    const automaticSetup = { queueAutomaticFirstTurn: vi.fn() };
    const { threadRepo, workspaceRepo, threadService, service } = createAgentServiceHarness(automaticSetup);
    const workspace = workspaceRepo.create("Repo", "/repo");
    const managed = threadRepo.create(workspace.id, "Managed first Turn", "worktree", "feature/managed", true, "claude");
    vi.mocked(threadService.create).mockResolvedValue(managed);

    const result = await service.createAndSend({
      workspaceId: workspace.id,
      content: "Queue this first Turn",
      mode: "worktree",
      branch: "feature/managed",
    });

    expect(automaticSetup.queueAutomaticFirstTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: managed.id,
      content: "Queue this first Turn",
      submission: expect.objectContaining({ messageId: expect.any(String) }),
    }));
    expect(service.sendMessage).not.toHaveBeenCalled();
    expect(result.runtimeSnapshot).toEqual({ threadId: managed.id, turnExecutionId: null, phase: "idle" });
  });

  it("dispatches a managed New first Turn without Continue when the workspace has no Setup", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcode-agent-automatic-setup-"));
    roots.push(root);
    const prepare = vi.fn();
    const { threadRepo, workspaceRepo, threadService, service, automaticSetup } = createAgentServiceHarness(({ db, threadRepo: threads }) =>
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
    vi.mocked(service.sendMessage).mockImplementation(async ({ threadId, onTurnStarted }) => {
      onTurnStarted?.({ threadId, turnExecutionId: "execution-1", phase: "running" });
      await providerCompletion.promise;
    });
    const environment = automaticSetup as WorkspaceEnvironmentService;
    environment.setAutomaticSetupDispatcher({ dispatch: (submission) => service.dispatchQueuedAutomaticTurn(submission) });

    await service.createAndSend({
      workspaceId: workspace.id,
      content: "Dispatch without Setup",
      mode: "worktree",
      branch: "feature/managed",
    });

    await eventually(() => expect(service.sendMessage).toHaveBeenCalledOnce());
    expect(prepare).not.toHaveBeenCalled();
    expect(environment.getAutomaticSetup({ threadId: managed.id })).toMatchObject({
      gate: "not-required",
      attempt: null,
      queuedTurn: { state: "dispatched", dispatchedAt: expect.any(String) },
    });
    providerCompletion.resolve();
  });

  it("keeps Direct and Existing worktree first Turns on immediate dispatch", async () => {
    const automaticSetup = { queueAutomaticFirstTurn: vi.fn() };
    const { workspaceRepo, gitService, service } = createAgentServiceHarness(automaticSetup);
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
    expect(service.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("returns the authoritative running runtime snapshot after startup", async () => {
    const { workspaceRepo, service } = createAgentServiceHarness();
    const workspace = workspaceRepo.create("Repo", "/repo");
    vi.mocked(service.sendMessage).mockImplementation(async ({ threadId, onTurnStarted }) => {
      const snapshot = (service as unknown as {
        turnRuntime: { start: (id: string) => TurnRuntimeSnapshot };
      }).turnRuntime.start(threadId);
      onTurnStarted?.(snapshot);
    });

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
    const { workspaceRepo, service } = createAgentServiceHarness();
    const workspace = workspaceRepo.create("Repo", "/repo");
    vi.mocked(service.sendMessage).mockRejectedValue(new Error("startup failed"));

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
    const { workspaceRepo, service } = createAgentServiceHarness();
    const workspace = workspaceRepo.create("Repo", "/repo");
    let finishProvider!: () => void;
    const providerDone = new Promise<void>((resolve) => {
      finishProvider = resolve;
    });
    vi.mocked(service.sendMessage).mockImplementation(async ({ threadId, onTurnStarted }) => {
      const snapshot = (service as unknown as {
        turnRuntime: { start: (id: string) => TurnRuntimeSnapshot };
      }).turnRuntime.start(threadId);
      onTurnStarted?.(snapshot);
      await providerDone;
    });

    const result = await service.createAndSend({
      workspaceId: workspace.id,
      content: "Start without waiting",
    });

    expect(result.runtimeSnapshot.phase).toBe("running");
    finishProvider();
  });

  it("uses the default model when the command omits it", async () => {
    const { threadRepo, workspaceRepo, service } = createAgentServiceHarness();
    const workspace = workspaceRepo.create("Repo", "/repo");

    const thread = await service.createAndSend({
      workspaceId: workspace.id,
      content: "Use the default model",
    });

    expect(thread.model).toBe("claude-sonnet-4-6");
    expect(threadRepo.findById(thread.id)?.model).toBe("claude-sonnet-4-6");
    expect(service.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: thread.id,
        content: "Use the default model",
        model: "claude-sonnet-4-6",
      }),
    );
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
