import "reflect-metadata";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { routeMessage, type RouterDeps } from "../ws-router.js";
import { WorkspaceEnvironmentService } from "../../../features/projects/environment/workspace-environment-service.js";
import { openMemoryDatabase } from "../../../runtime/persistence/sqlite/database.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workspace environment RPC", () => {
  it("serves valid read/save calls and reports malformed payloads structurally", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcode-environment-rpc-"));
    roots.push(root);
    const workspaceEnvironmentService = new WorkspaceEnvironmentService(root);
    const deps = {
      workspaceService: { findById: (id: string) => id === "workspace-1" ? { id } : null },
      workspaceEnvironmentService,
    } as unknown as RouterDeps;

    const read = await routeMessage(JSON.stringify({ id: "read", method: "workspace.environment.read", params: { workspaceId: "workspace-1" } }), deps);
    expect(read.error).toBeUndefined();
    expect(read.result).toMatchObject({ status: "absent", revision: null });

    const save = await routeMessage(JSON.stringify({
      id: "save",
      method: "workspace.environment.save",
      params: {
        workspaceId: "workspace-1",
        sourceRevision: null,
        document: { version: "0.0.1", actions: [{ id: "action-1", name: "Run app", command: { default: "bun run dev" } }] },
      },
    }), deps);
    expect(save.error).toBeUndefined();
    expect(save.result).toMatchObject({ status: "present" });

    const malformed = await routeMessage(JSON.stringify({
      id: "bad",
      method: "workspace.environment.save",
      params: {
        workspaceId: "workspace-1",
        sourceRevision: null,
        document: { version: "0.0.1", actions: [], extra: true },
      },
    }), deps);
    expect(malformed.error?.code).toBe("WORKSPACE_ENVIRONMENT_VALIDATION");
    expect(malformed.error?.data).toEqual(expect.objectContaining({ issues: expect.any(Array) }));
  });

  it("routes storage selection and approval clearing through the workspace environment boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcode-environment-rpc-"));
    roots.push(root);
    const baseCheckout = join(root, "base");
    const workspace = { id: "workspace-1", path: baseCheckout };
    const workspaceEnvironmentService = new WorkspaceEnvironmentService({
      mcodeDir: root,
      workspaces: { findById: (id) => id === workspace.id ? workspace : null },
    });
    const deps = {
      workspaceService: { findById: (id: string) => id === workspace.id ? workspace : null },
      workspaceEnvironmentService,
    } as unknown as RouterDeps;

    const selected = await routeMessage(JSON.stringify({
      id: "storage",
      method: "workspace.environment.storage.set",
      params: { workspaceId: workspace.id, storageMode: "shared" },
    }), deps);
    expect(selected.result).toMatchObject({ status: "absent", storageMode: "shared" });

    const cleared = await routeMessage(JSON.stringify({
      id: "clear",
      method: "workspace.environment.command.clearApprovals",
      params: { workspaceId: workspace.id },
    }), deps);
    expect(cleared.error).toBeUndefined();
    expect(cleared.result).toBeUndefined();

    const malformed = await routeMessage(JSON.stringify({
      id: "clear-invalid",
      method: "workspace.environment.command.clearApprovals",
      params: { workspaceId: workspace.id, extra: true },
    }), deps);
    expect(malformed.error?.code).toBe("WORKSPACE_ENVIRONMENT_VALIDATION");
  });

  it("starts and reads the typed transient manual Setup attempt", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcode-environment-rpc-"));
    roots.push(root);
    const workspaceEnvironmentService = new WorkspaceEnvironmentService({
      mcodeDir: root,
      threads: { findById: (id) => id === "thread-1" ? { id, workspace_id: "workspace-1", mode: "direct" } : null },
      terminalCommands: {
        prepare: async () => ({
          kind: "ready" as const,
          command: {
            snapshot: {
              checkoutPath: "C:\\workspace",
              terminal: { executable: "pwsh.exe", arguments: ["-NoProfile", "-NonInteractive", "-Command", "setup"] },
            },
            start: async () => await new Promise<never>(() => undefined),
            close: async () => ({ kind: "contained" as const }),
            waitForRelease: async () => await new Promise<never>(() => undefined),
          },
        }),
      },
      platform: "windows",
      createAttemptId: () => "attempt-1",
      now: () => new Date("2026-08-22T12:00:00.000Z"),
    });
    await workspaceEnvironmentService.save({
      workspaceId: "workspace-1",
      sourceRevision: null,
      document: { version: "0.0.1", setup: { windows: "setup" }, actions: [] },
    });
    const deps = {
      workspaceService: { findById: (id: string) => id === "workspace-1" ? { id } : null },
      workspaceEnvironmentService,
    } as unknown as RouterDeps;

    const started = await routeMessage(JSON.stringify({
      id: "start",
      method: "workspace.environment.setup.start",
      params: { threadId: "thread-1" },
    }), deps);
    expect(started.error).toBeUndefined();
    expect(started.result).toMatchObject({
      id: "attempt-1",
      status: "running",
      outcome: null,
      snapshot: { platform: "windows", script: "setup", checkoutPath: "C:\\workspace" },
    });

    const latest = await routeMessage(JSON.stringify({
      id: "latest",
      method: "workspace.environment.setup.get",
      params: { threadId: "thread-1" },
    }), deps);
    expect(latest.error).toBeUndefined();
    expect(latest.result).toMatchObject({ attempt: { id: "attempt-1", status: "running" } });
  });

  it("routes strict automatic Setup lifecycle reads and recovery mutations", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcode-environment-rpc-"));
    roots.push(root);
    const database = openMemoryDatabase();
    const workspaceEnvironmentService = new WorkspaceEnvironmentService({
      mcodeDir: root,
      database,
      threads: { findById: (id) => id === "thread-1" ? { id, workspace_id: "workspace-1", mode: "worktree", worktree_managed: true } : null },
      terminalRecovery: { create: () => ({ ptyId: "recovery-pty", shell: "pwsh" }) },
      platform: "linux",
    });
    const deps = {
      workspaceService: { findById: () => null },
      workspaceEnvironmentService,
    } as unknown as RouterDeps;

    const get = await routeMessage(JSON.stringify({
      id: "automatic-get",
      method: "workspace.environment.automaticSetup.get",
      params: { threadId: "thread-1" },
    }), deps);
    expect(get.result).toEqual({ gate: "not-required", attempt: null, queuedTurns: [] });

    const continued = await routeMessage(JSON.stringify({
      id: "automatic-continue",
      method: "workspace.environment.automaticSetup.continue",
      params: { threadId: "thread-1" },
    }), deps);
    expect(continued.error).toMatchObject({
      code: "WORKSPACE_ENVIRONMENT_SETUP_UNAVAILABLE",
      message: "Automatic Setup can continue only after Setup failed or was interrupted",
    });
    expect(continued.result).toBeUndefined();
    expect(workspaceEnvironmentService.getAutomaticSetup({ threadId: "thread-1" })).toEqual({
      gate: "not-required",
      attempt: null,
      queuedTurns: [],
    });

    const cancelled = await routeMessage(JSON.stringify({
      id: "automatic-cancel",
      method: "workspace.environment.automaticSetup.cancelQueuedTurn",
      params: { threadId: "thread-1", queuedTurnId: "queued-1" },
    }), deps);
    expect(cancelled.result).toEqual({ gate: "not-required", attempt: null, queuedTurns: [] });

    const stopped = await routeMessage(JSON.stringify({
      id: "automatic-stop",
      method: "workspace.environment.automaticSetup.stop",
      params: { threadId: "thread-1" },
    }), deps);
    expect(stopped.result).toEqual({ gate: "not-required", attempt: null, queuedTurns: [] });

    const terminal = await routeMessage(JSON.stringify({
      id: "automatic-terminal",
      method: "workspace.environment.automaticSetup.openTerminal",
      params: { threadId: "thread-1" },
    }), deps);
    expect(terminal.result).toEqual({ ptyId: "recovery-pty", shell: "pwsh" });

    const malformed = await routeMessage(JSON.stringify({
      id: "automatic-bad",
      method: "workspace.environment.automaticSetup.get",
      params: { threadId: "thread-1", extra: true },
    }), deps);
    expect(malformed.error?.code).toBe("WORKSPACE_ENVIRONMENT_VALIDATION");

    const malformedCancel = await routeMessage(JSON.stringify({
      id: "automatic-cancel-bad",
      method: "workspace.environment.automaticSetup.cancelQueuedTurn",
      params: { threadId: "thread-1" },
    }), deps);
    expect(malformedCancel.error?.code).toBe("WORKSPACE_ENVIRONMENT_VALIDATION");

    database.prepare("INSERT INTO workspaces (id, name, path, provider_config) VALUES ('workspace-1', 'Project', '/project', '{}')").run();
    database.prepare("INSERT INTO threads (id, workspace_id, title, mode, branch, worktree_managed, provider) VALUES ('thread-1', 'workspace-1', 'Blocked Turn', 'worktree', 'main', 1, 'claude')").run();
    await workspaceEnvironmentService.save({
      workspaceId: "workspace-1",
      sourceRevision: null,
      document: { version: "0.0.1", setup: { linux: "bun run setup" }, actions: [] },
    });
    workspaceEnvironmentService.queueAutomaticFirstTurn({
      threadId: "thread-1",
      messageId: "message-1",
      content: "Blocked Turn",
      attachments: [],
      mentions: [],
      submission: {
        threadId: "thread-1",
        messageId: "message-1",
        content: "Blocked Turn",
        displayContent: "Blocked Turn",
        model: "claude-sonnet-4-6",
        permissionMode: "default",
        attachments: [],
        persistedAttachments: [],
        mentions: [],
        provider: "claude",
      },
    });
    await expect.poll(() => workspaceEnvironmentService.getAutomaticSetup({ threadId: "thread-1" }).attempt?.state)
      .toBe("failed");

    const validContinue = await routeMessage(JSON.stringify({
      id: "automatic-continue-valid",
      method: "workspace.environment.automaticSetup.continue",
      params: { threadId: "thread-1" },
    }), deps);
    expect(validContinue.error).toBeUndefined();
    expect(validContinue.result).toMatchObject({
      gate: "released-by-continue",
      attempt: { state: "failed" },
      queuedTurns: [{ state: "released", messageId: "message-1" }],
    });
  });
});
