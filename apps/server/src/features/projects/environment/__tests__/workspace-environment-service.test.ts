import "reflect-metadata";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WorkspaceEnvironmentService,
  WorkspaceEnvironmentServiceError,
} from "../workspace-environment-service.js";
import { WORKSPACE_ENVIRONMENT_DOCUMENT_MAX_BYTES } from "@mcode/contracts";
import type {
  TerminalCommandCompletion,
  TerminalCommandPreparation,
} from "../../../terminal/commands/terminal-command-service.js";

const workspaceId = "workspace-1";
const document = {
  version: "0.0.1" as const,
  actions: [{ id: "action-1", name: "Run app", command: { default: "bun run dev" } }],
};

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function service(): Promise<{ root: string; instance: WorkspaceEnvironmentService }> {
  const root = await mkdtemp(join(tmpdir(), "mcode-environment-"));
  roots.push(root);
  return { root, instance: new WorkspaceEnvironmentService(root) };
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

async function waitFor(assertion: () => void): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 32; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      failure = error;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  throw failure;
}

describe("WorkspaceEnvironmentService", () => {
  it("reads an absent default and saves at projects/<workspace-id>/environment.json", async () => {
    const { root, instance } = await service();
    const absent = await instance.read(workspaceId);
    expect(absent).toEqual({ document: { version: "0.0.1", actions: [] }, revision: null, status: "absent", storageMode: "system" });
    const saved = await instance.save({ workspaceId, sourceRevision: absent.revision, document });
    expect(saved.document).toEqual(document);
    expect(saved.revision).toBeTruthy();
    expect(await readFile(join(root, "projects", workspaceId, "environment.json"), "utf8")).toContain('"version":"0.0.1"');
  });

  it("replaces atomically and rejects stale saves without changing newer bytes", async () => {
    const { root, instance } = await service();
    const first = await instance.save({ workspaceId, sourceRevision: null, document });
    const newer = await instance.save({ workspaceId, sourceRevision: first.revision, document: { ...document, actions: [] } });
    const path = join(root, "projects", workspaceId, "environment.json");
    const before = await readFile(path, "utf8");
    await expect(instance.save({ workspaceId, sourceRevision: first.revision, document })).rejects.toMatchObject({ code: "WORKSPACE_ENVIRONMENT_STALE" });
    expect(await readFile(path, "utf8")).toBe(before);
    expect(newer.revision).not.toBe(first.revision);
    expect((await readdir(join(root, "projects", workspaceId))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("serializes concurrent saves so exactly one wins a shared revision", async () => {
    const { root, instance } = await service();
    const firstDocument = { ...document, actions: [{ ...document.actions[0], name: "First" }] };
    const secondDocument = { ...document, actions: [{ ...document.actions[0], name: "Second" }] };
    const saves = await Promise.allSettled([
      instance.save({ workspaceId, sourceRevision: null, document: firstDocument }),
      instance.save({ workspaceId, sourceRevision: null, document: secondDocument }),
    ]);
    const successes = saves.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<WorkspaceEnvironmentService["save"]>>> => result.status === "fulfilled");
    const stale = saves.filter((result) => result.status === "rejected");
    expect(successes).toHaveLength(1);
    expect(stale).toHaveLength(1);
    expect(stale[0]?.reason).toMatchObject({ code: "WORKSPACE_ENVIRONMENT_STALE" });
    const persisted = await instance.read(workspaceId);
    expect(persisted.document).toEqual(successes[0]?.value.document);
    expect(await readFile(join(root, "projects", workspaceId, "environment.json"), "utf8")).toContain(persisted.document.actions[0]?.name);
  });

  it("reads and writes the selected worktree checkout without accepting a revision from another storage scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcode-environment-worktree-"));
    roots.push(root);
    const baseCheckout = join(root, "base");
    const worktreeCheckout = join(root, "worktree");
    await mkdir(worktreeCheckout, { recursive: true });
    const instance = new WorkspaceEnvironmentService({
      mcodeDir: root,
      workspaces: { findById: (id) => id === workspaceId ? { id, path: baseCheckout } : null },
      threads: {
        findById: (id) => id === "worktree"
          ? { id, workspace_id: workspaceId, mode: "worktree", worktree_path: worktreeCheckout }
          : null,
      },
    });

    await instance.setStorageMode({ workspaceId, threadId: "worktree", storageMode: "shared" });
    const worktreeRead = await instance.read(workspaceId, "worktree");
    const worktreeSaved = await instance.save({
      workspaceId,
      threadId: "worktree",
      sourceRevision: worktreeRead.revision,
      document,
    });
    const baseSaved = await instance.save({ workspaceId, sourceRevision: null, document });

    expect(await readFile(join(worktreeCheckout, ".mcode", "environment.json"), "utf8")).toContain('"bun run dev"');
    await expect(instance.save({
      workspaceId,
      threadId: "worktree",
      sourceRevision: baseSaved.revision,
      document: { ...document, actions: [] },
    })).rejects.toMatchObject({ code: "WORKSPACE_ENVIRONMENT_STALE" });
    expect(worktreeSaved.revision).not.toBe(baseSaved.revision);
  });

  it("requires approval for the exact shared Setup command and never falls back from a worktree checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcode-environment-shared-"));
    roots.push(root);
    const baseCheckout = join(root, "base");
    const worktreeCheckout = join(root, "worktree");
    await mkdir(join(baseCheckout, ".mcode"), { recursive: true });
    await mkdir(worktreeCheckout, { recursive: true });
    await writeFile(join(baseCheckout, ".mcode", "environment.json"), JSON.stringify({
      version: "0.0.1",
      setup: { default: "bun run setup" },
      actions: [{ id: "build", name: "Build", command: { default: "bun run build" } }],
    }));
    const start = vi.fn(async () => ({ kind: "exited" as const, exitCode: 0, output: "ready", outputTruncated: false }));
    const close = vi.fn(async () => ({ kind: "contained" as const }));
    const prepare = vi.fn(async () => ({
      kind: "ready" as const,
      command: {
        snapshot: {
          checkoutPath: baseCheckout,
          terminal: { executable: "pwsh.exe", arguments: ["-Command", "bun run setup"] },
        },
        start,
        close,
        waitForRelease: async () => undefined,
      },
    }));
    const instance = new WorkspaceEnvironmentService({
      mcodeDir: root,
      workspaces: { findById: (id) => id === workspaceId ? { id, path: baseCheckout } : null },
      threads: {
        findById: (id) => id === "direct"
          ? { id, workspace_id: workspaceId, mode: "direct" }
          : id === "worktree"
            ? { id, workspace_id: workspaceId, mode: "worktree", worktree_managed: false, worktree_path: worktreeCheckout }
            : null,
      },
      terminalCommands: { prepare },
    });

    expect((await instance.read(workspaceId)).storageMode).toBe("shared");
    const pending = await instance.startSetup({ threadId: "direct" });
    expect(pending.status).toBe("awaiting-approval");
    expect(pending.snapshot.script).toBe("bun run setup");
    expect(start).not.toHaveBeenCalled();
    const approval = pending.snapshot.approval;
    expect(approval).not.toBeNull();
    if (!approval) throw new Error("Expected a shared command approval");

    await expect(instance.approveCommand({ ...approval, threadId: "direct", fingerprint: "0".repeat(64) }))
      .rejects.toMatchObject({ code: "WORKSPACE_ENVIRONMENT_APPROVAL_STALE" });
    await instance.approveCommand({ ...approval, threadId: "direct" });
    expect((await instance.startSetup({ threadId: "direct" })).status).toBe("running");
    await waitFor(() => expect(instance.getSetupAttempt({ threadId: "direct" }).attempt?.status).toBe("passed"));
    expect(start).toHaveBeenCalledOnce();

    const actionResolution = await instance.resolveActionCommand("direct", "build");
    expect(actionResolution.kind).toBe("ready");
    if (actionResolution.kind !== "ready" || !actionResolution.approval) throw new Error("Expected Action approval");
    await instance.approveCommand({ threadId: "direct", ...actionResolution.approval });
    const approvedAction = await instance.resolveActionCommand("direct", "build");
    expect(approvedAction.kind === "ready" && approvedAction.approval).toBeNull();
    if (approvedAction.kind === "ready") await approvedAction.command.close();
    instance.clearApprovals(workspaceId);
    const clearedAction = await instance.resolveActionCommand("direct", "build");
    expect(clearedAction.kind === "ready" && clearedAction.approval?.target).toEqual({ kind: "action", actionId: "build" });
    if (clearedAction.kind === "ready") await clearedAction.command.close();

    const worktreeAttempt = await instance.startSetup({ threadId: "worktree" });
    expect(worktreeAttempt.status).toBe("unavailable");

    await writeFile(join(baseCheckout, ".mcode", "environment.json"), JSON.stringify({
      version: "0.0.1",
      setup: { default: "echo first\r\necho second" },
      actions: [],
    }));
    const crlfFingerprint = (await instance.startSetup({ threadId: "direct" })).snapshot.approval?.fingerprint;
    await writeFile(join(baseCheckout, ".mcode", "environment.json"), JSON.stringify({
      version: "0.0.1",
      setup: { default: "echo first\necho second" },
      actions: [],
    }));
    const lfFingerprint = (await instance.startSetup({ threadId: "direct" })).snapshot.approval?.fingerprint;
    expect(lfFingerprint).toBe(crlfFingerprint);
    expect(prepare).toHaveBeenCalledTimes(10);
  });

  it("rejects oversized persisted bytes before parsing and preserves the file", async () => {
    const { root, instance } = await service();
    const path = join(root, "projects", workspaceId, "environment.json");
    await mkdir(join(root, "projects", workspaceId), { recursive: true });
    const oversized = `${JSON.stringify({ version: "0.0.1", actions: [] })}${" ".repeat(128 * 1024)}`;
    await writeFile(path, oversized);
    await expect(instance.read(workspaceId)).rejects.toMatchObject({
      code: "WORKSPACE_ENVIRONMENT_VALIDATION",
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "DOCUMENT_TOO_LARGE", reason: "document_too_large" }),
      ]),
    });
    expect(await readFile(path, "utf8")).toBe(oversized);
  });

  it("persists near-limit documents canonically within the raw byte bound", async () => {
    const { root, instance } = await service();
    const nearLimit = {
      version: "0.0.1" as const,
      actions: Array.from({ length: 256 }, (_, index) => ({
        id: `${index}${"i".repeat(40 - String(index).length)}`,
        name: "n".repeat(150),
        command: { default: "x".repeat(250) },
      })),
    };
    const encoder = new TextEncoder();
    expect(encoder.encode(JSON.stringify(nearLimit)).byteLength).toBeLessThanOrEqual(WORKSPACE_ENVIRONMENT_DOCUMENT_MAX_BYTES);
    expect(encoder.encode(`${JSON.stringify(nearLimit, null, 2)}\n`).byteLength).toBeGreaterThan(WORKSPACE_ENVIRONMENT_DOCUMENT_MAX_BYTES);

    const saved = await instance.save({ workspaceId, sourceRevision: null, document: nearLimit });
    const path = join(root, "projects", workspaceId, "environment.json");
    const raw = await readFile(path);
    expect(raw.byteLength).toBeLessThanOrEqual(WORKSPACE_ENVIRONMENT_DOCUMENT_MAX_BYTES);
    expect((await instance.read(workspaceId)).document).toEqual(saved.document);
  });

  it("keeps existing bytes when validation or unsupported-version checks fail", async () => {
    const { root, instance } = await service();
    const saved = await instance.save({ workspaceId, sourceRevision: null, document });
    const path = join(root, "projects", workspaceId, "environment.json");
    const before = await readFile(path, "utf8");
    await expect(instance.save({ workspaceId, sourceRevision: saved.revision, document: { ...document, setup: {} } })).rejects.toMatchObject({ code: "WORKSPACE_ENVIRONMENT_VALIDATION" });
    expect(await readFile(path, "utf8")).toBe(before);

    await writeFile(path, JSON.stringify({ ...document, version: "9.9.9" }));
    await expect(instance.read(workspaceId)).rejects.toBeInstanceOf(WorkspaceEnvironmentServiceError);
    await expect(instance.save({ workspaceId, sourceRevision: saved.revision, document })).rejects.toMatchObject({ code: "WORKSPACE_ENVIRONMENT_UNSUPPORTED_VERSION" });
    expect(await readFile(path, "utf8")).toContain('"version":"9.9.9"');
  });

  it("runs one transient Setup attempt with the OS override and records a nonzero command result", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcode-environment-setup-"));
    roots.push(root);
    let finish!: (completion: TerminalCommandCompletion) => void;
    const completion = new Promise<TerminalCommandCompletion>((resolve) => { finish = resolve; });
    const start = vi.fn(() => completion);
    const prepare = vi.fn(async () => ({
      kind: "ready" as const,
      command: {
        snapshot: {
          checkoutPath: "C:\\workspace",
          terminal: { executable: "pwsh.exe", arguments: ["-NoProfile", "-NonInteractive", "-Command", "windows setup"] },
        },
        start,
        close: async () => ({ kind: "contained" as const }),
        waitForRelease: async () => await new Promise<never>(() => undefined),
      },
    }));
    const instance = new WorkspaceEnvironmentService({
      mcodeDir: root,
      threads: { findById: (id) => id === "thread-1" ? { id, workspace_id: workspaceId, mode: "direct" } : null },
      terminalCommands: { prepare },
      platform: "windows",
      createAttemptId: () => "attempt-1",
      now: () => new Date("2026-08-22T12:00:00.000Z"),
    });
    await instance.save({
      workspaceId,
      sourceRevision: null,
      document: { version: "0.0.1", setup: { default: "default setup", windows: "windows setup" }, actions: [] },
    });

    const running = await instance.startSetup({ threadId: "thread-1" });
    const repeated = await instance.startSetup({ threadId: "thread-1" });
    expect(repeated).toBe(running);
    expect(running).toMatchObject({
      status: "running",
      outcome: null,
      snapshot: { platform: "windows", script: "windows setup", checkoutPath: "C:\\workspace" },
    });
    expect(Object.isFrozen(running.snapshot)).toBe(true);
    expect(JSON.stringify(running)).not.toContain("SECRET");
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ script: "windows setup" }));

    await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(1);
    finish({ kind: "exited", exitCode: 2, output: "missing dependency", outputTruncated: false });
    await Promise.resolve();
    await Promise.resolve();

    expect(instance.getSetupAttempt({ threadId: "thread-1" }).attempt).toMatchObject({
      id: "attempt-1",
      status: "failed",
      outcome: "command_failure",
      exitCode: 2,
      output: "missing dependency",
    });
  });

  it("records an unavailable attempt when the current OS has no Setup script", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcode-environment-setup-"));
    roots.push(root);
    const prepare = vi.fn();
    const instance = new WorkspaceEnvironmentService({
      mcodeDir: root,
      threads: { findById: (id) => id === "thread-1" ? { id, workspace_id: workspaceId, mode: "worktree", worktree_managed: false } : null },
      terminalCommands: { prepare },
      platform: "windows",
      createAttemptId: () => "attempt-2",
      now: () => new Date("2026-08-22T12:00:00.000Z"),
    });
    await instance.save({
      workspaceId,
      sourceRevision: null,
      document: { version: "0.0.1", setup: { macos: "mac setup" }, actions: [] },
    });

    await expect(instance.startSetup({ threadId: "thread-1" })).resolves.toMatchObject({
      status: "unavailable",
      outcome: "unavailable",
      snapshot: { platform: "windows", script: null, terminal: null },
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("allows Direct and existing worktree Threads but rejects managed and deleting Threads", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcode-environment-setup-"));
    roots.push(root);
    const threads = new Map([
      ["direct", { id: "direct", workspace_id: workspaceId, mode: "direct", worktree_managed: true }],
      ["existing", { id: "existing", workspace_id: workspaceId, mode: "worktree", worktree_managed: false }],
      ["managed", { id: "managed", workspace_id: workspaceId, mode: "worktree", worktree_managed: true }],
      ["deleting", { id: "deleting", workspace_id: workspaceId, mode: "direct", worktree_managed: true, cleanup_state: "running" }],
      ["deleted", { id: "deleted", workspace_id: workspaceId, mode: "direct", worktree_managed: true, deleted_at: "2026-08-22T12:00:00.000Z" }],
    ]);
    const instance = new WorkspaceEnvironmentService({
      mcodeDir: root,
      threads: { findById: (id) => threads.get(id) ?? null },
      platform: "windows",
    });

    await expect(instance.startSetup({ threadId: "direct" })).resolves.toMatchObject({ status: "unavailable" });
    await expect(instance.startSetup({ threadId: "existing" })).resolves.toMatchObject({ status: "unavailable" });
    await expect(instance.startSetup({ threadId: "managed" })).rejects.toMatchObject({
      code: "WORKSPACE_ENVIRONMENT_SETUP_UNAVAILABLE",
    });
    await expect(instance.startSetup({ threadId: "deleting" })).rejects.toMatchObject({
      code: "WORKSPACE_ENVIRONMENT_SETUP_UNAVAILABLE",
    });
    await expect(instance.startSetup({ threadId: "deleted" })).rejects.toMatchObject({
      code: "WORKSPACE_ENVIRONMENT_SETUP_UNAVAILABLE",
    });
  });

  it("uses a nonblank default when the current OS override is blank", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcode-environment-setup-"));
    roots.push(root);
    const prepare = vi.fn(async () => ({
      kind: "unavailable" as const,
      snapshot: { checkoutPath: "C:\\workspace", terminal: null },
      output: "Terminal unavailable",
    }));
    const instance = new WorkspaceEnvironmentService({
      mcodeDir: root,
      threads: { findById: (id) => id === "thread-1" ? { id, workspace_id: workspaceId, mode: "direct", worktree_managed: true } : null },
      terminalCommands: { prepare },
      platform: "windows",
    });
    await instance.save({
      workspaceId,
      sourceRevision: null,
      document: { version: "0.0.1", setup: { default: "  bun run setup  ", windows: " \t " }, actions: [] },
    });

    await expect(instance.startSetup({ threadId: "thread-1" })).resolves.toMatchObject({
      status: "unavailable",
      snapshot: { script: "  bun run setup  " },
    });
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ script: "  bun run setup  " }));
  });

  it("records a configuration failure for an invalid current environment document", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcode-environment-setup-"));
    roots.push(root);
    const prepare = vi.fn();
    const instance = new WorkspaceEnvironmentService({
      mcodeDir: root,
      threads: { findById: (id) => id === "thread-1" ? { id, workspace_id: workspaceId, mode: "direct" } : null },
      terminalCommands: { prepare },
      platform: "windows",
      createAttemptId: () => "attempt-invalid",
      now: () => new Date("2026-08-22T12:00:00.000Z"),
    });
    const path = join(root, "projects", workspaceId, "environment.json");
    await mkdir(join(root, "projects", workspaceId), { recursive: true });
    await writeFile(path, JSON.stringify({ version: "9.9.9", actions: [] }));

    await expect(instance.startSetup({ threadId: "thread-1" })).resolves.toMatchObject({
      id: "attempt-invalid",
      status: "failed",
      outcome: "configuration_failure",
      snapshot: { platform: "windows", script: null, terminal: null },
      output: "Project Setup configuration is invalid",
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("classifies a contained timeout without changing the latest attempt identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcode-environment-setup-"));
    roots.push(root);
    const instance = new WorkspaceEnvironmentService({
      mcodeDir: root,
      threads: { findById: (id) => id === "thread-1" ? { id, workspace_id: workspaceId, mode: "direct" } : null },
      terminalCommands: {
        prepare: async () => ({
          kind: "ready" as const,
          command: {
            snapshot: { checkoutPath: "C:\\workspace", terminal: { executable: "pwsh.exe", arguments: ["-Command", "setup"] } },
            start: async () => ({ kind: "timeout" as const, output: "timed out", outputTruncated: false }),
            close: async () => ({ kind: "contained" as const }),
            waitForRelease: async () => await new Promise<never>(() => undefined),
          },
        }),
      },
      platform: "windows",
      createAttemptId: () => "attempt-timeout",
      now: () => new Date("2026-08-22T12:00:00.000Z"),
    });
    await instance.save({
      workspaceId,
      sourceRevision: null,
      document: { version: "0.0.1", setup: { windows: "setup" }, actions: [] },
    });

    const running = await instance.startSetup({ threadId: "thread-1" });
    await Promise.resolve();
    await Promise.resolve();
    expect(instance.getSetupAttempt({ threadId: "thread-1" }).attempt).toMatchObject({
      id: running.id,
      status: "failed",
      outcome: "timeout",
      exitCode: null,
      output: "timed out",
    });
  });

  it("retains ownership after a containment failure until the command releases", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcode-environment-setup-"));
    roots.push(root);
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const close = vi.fn(async () => ({ kind: "containment_failure" as const }));
    const instance = new WorkspaceEnvironmentService({
      mcodeDir: root,
      threads: { findById: (id) => id === "thread-1" ? { id, workspace_id: workspaceId, mode: "direct" } : null },
      terminalCommands: {
        prepare: async () => ({
          kind: "ready" as const,
          command: {
            snapshot: { checkoutPath: "C:\\workspace", terminal: { executable: "pwsh.exe", arguments: ["-Command", "setup"] } },
            start: async () => ({ kind: "containment_failure" as const, output: "", outputTruncated: false }),
            close,
            waitForRelease: async () => await released,
          },
        }),
      },
      platform: "windows",
      createAttemptId: () => "attempt-containment",
      now: () => new Date("2026-08-22T12:00:00.000Z"),
    });
    await instance.save({ workspaceId, sourceRevision: null, document: { version: "0.0.1", setup: { windows: "setup" }, actions: [] } });

    await instance.startSetup({ threadId: "thread-1" });
    await Promise.resolve();
    await Promise.resolve();
    expect(instance.getSetupAttempt({ threadId: "thread-1" }).attempt).toMatchObject({
      status: "failed",
      outcome: "containment_failure",
      cleanupPending: true,
    });
    await expect(instance.cancelSetupForThread("thread-1")).rejects.toThrow("Project Setup process containment failed");
    expect(close).toHaveBeenCalledTimes(1);

    release();
    await released;
    await Promise.resolve();
    expect(instance.getSetupAttempt({ threadId: "thread-1" }).attempt).toMatchObject({
      outcome: "containment_failure",
      cleanupPending: false,
    });
    await instance.cancelSetupForThread("thread-1");
    expect(instance.getSetupAttempt({ threadId: "thread-1" }).attempt).toBeNull();
  });

  it("cancels Setup by Thread, workspace, and server disposal", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcode-environment-setup-"));
    roots.push(root);
    const closeByThread = vi.fn(async () => ({ kind: "contained" as const }));
    const closeByWorkspace = vi.fn(async () => ({ kind: "contained" as const }));
    const closeOnDispose = vi.fn(async () => ({ kind: "contained" as const }));
    const commands = [closeByThread, closeByWorkspace, closeOnDispose];
    let index = 0;
    const instance = new WorkspaceEnvironmentService({
      mcodeDir: root,
      threads: {
        findById: (id) => ({
          id,
          workspace_id: id === "thread-workspace" ? "workspace-2" : workspaceId,
          mode: "direct",
        }),
      },
      terminalCommands: {
        prepare: async () => {
          const close = commands[index++]!;
          return {
            kind: "ready" as const,
            command: {
              snapshot: { checkoutPath: "C:\\workspace", terminal: { executable: "pwsh.exe", arguments: ["-Command", "setup"] } },
              start: async () => await new Promise<never>(() => undefined),
              close,
              waitForRelease: async () => await new Promise<never>(() => undefined),
            },
          };
        },
      },
      platform: "windows",
      createAttemptId: () => `attempt-${index}`,
    });
    for (const id of [workspaceId, "workspace-2"]) {
      await instance.save({ workspaceId: id, sourceRevision: null, document: { version: "0.0.1", setup: { windows: "setup" }, actions: [] } });
    }

    await instance.startSetup({ threadId: "thread-thread" });
    await instance.cancelSetupForThread("thread-thread");
    expect(closeByThread).toHaveBeenCalledTimes(1);
    expect(instance.getSetupAttempt({ threadId: "thread-thread" }).attempt).toBeNull();

    await instance.startSetup({ threadId: "thread-workspace" });
    await instance.cancelSetupForWorkspace("workspace-2");
    expect(closeByWorkspace).toHaveBeenCalledTimes(1);
    expect(instance.getSetupAttempt({ threadId: "thread-workspace" }).attempt).toBeNull();

    await instance.startSetup({ threadId: "thread-dispose" });
    await instance.dispose();
    expect(closeOnDispose).toHaveBeenCalledTimes(1);
    expect(instance.getSetupAttempt({ threadId: "thread-dispose" }).attempt).toBeNull();
  });

  it("rejects new Setup once disposal begins without preparing or starting another command", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcode-environment-setup-"));
    roots.push(root);
    const closeEntered = deferred<void>();
    const closeRelease = deferred<void>();
    const start = vi.fn(async () => await new Promise<TerminalCommandCompletion>(() => undefined));
    const close = vi.fn(async () => {
      closeEntered.resolve();
      await closeRelease.promise;
      return { kind: "contained" as const };
    });
    const prepare = vi.fn(async () => ({
      kind: "ready" as const,
      command: {
        snapshot: { checkoutPath: "C:\\workspace", terminal: { executable: "pwsh.exe", arguments: ["-Command", "setup"] } },
        start,
        close,
        waitForRelease: async () => await new Promise<never>(() => undefined),
      },
    }));
    const instance = new WorkspaceEnvironmentService({
      mcodeDir: root,
      threads: {
        findById: (id) => id === "thread-running" || id === "thread-new"
          ? { id, workspace_id: workspaceId, mode: "direct" }
          : null,
      },
      terminalCommands: { prepare },
      platform: "windows",
    });
    await instance.save({ workspaceId, sourceRevision: null, document: { version: "0.0.1", setup: { windows: "setup" }, actions: [] } });
    await instance.startSetup({ threadId: "thread-running" });
    await Promise.resolve();

    const disposing = instance.dispose();
    const duplicateDispose = instance.dispose();
    await closeEntered.promise;
    await expect(instance.startSetup({ threadId: "thread-new" })).rejects.toMatchObject({
      code: "WORKSPACE_ENVIRONMENT_SETUP_UNAVAILABLE",
    });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);

    closeRelease.resolve();
    await Promise.all([disposing, duplicateDispose]);
  });

  it("waits for a pending preparation, closes it, and prevents a cancelled Thread from starting Setup", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcode-environment-setup-"));
    roots.push(root);
    const pending = deferred<TerminalCommandPreparation>();
    const start = vi.fn();
    const close = vi.fn(async () => ({ kind: "contained" as const }));
    const prepare = vi.fn(() => pending.promise);
    const instance = new WorkspaceEnvironmentService({
      mcodeDir: root,
      threads: { findById: (id) => id === "thread-pending" ? { id, workspace_id: workspaceId, mode: "direct" } : null },
      terminalCommands: { prepare },
      platform: "windows",
    });
    await instance.save({ workspaceId, sourceRevision: null, document: { version: "0.0.1", setup: { windows: "setup" }, actions: [] } });

    const starting = instance.startSetup({ threadId: "thread-pending" });
    void starting.catch(() => undefined);
    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
    const cancellation = instance.cancelSetupForThread("thread-pending");
    let cancelled = false;
    void cancellation.then(() => { cancelled = true; });
    await Promise.resolve();
    expect(cancelled).toBe(false);

    pending.resolve({
      kind: "ready",
      command: {
        snapshot: { checkoutPath: "C:\\workspace", terminal: { executable: "pwsh.exe", arguments: ["-Command", "setup"] } },
        start,
        close,
        waitForRelease: async () => undefined,
      },
    });

    await expect(cancellation).resolves.toBeUndefined();
    await expect(starting).rejects.toThrow("Project Setup start was cancelled");
    expect(close).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
    expect(instance.getSetupAttempt({ threadId: "thread-pending" }).attempt).toBeNull();
  });

  it("bounds Thread, workspace, and shutdown cancellation while preparations settle late", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcode-environment-setup-"));
    roots.push(root);
    const timers: Array<() => void> = [];
    const pendingByThread = new Map<string, ReturnType<typeof deferred<TerminalCommandPreparation>>>();
    const commands = new Map<string, TerminalCommandPreparation>();
    const prepare = vi.fn((input: { readonly scope: { readonly threadId: string } }) => {
      const pending = deferred<TerminalCommandPreparation>();
      const start = vi.fn(async () => await new Promise<never>(() => undefined));
      const close = vi.fn(async () => ({ kind: "contained" as const }));
      pendingByThread.set(input.scope.threadId, pending);
      commands.set(input.scope.threadId, {
        kind: "ready",
        command: {
          snapshot: { checkoutPath: "C:\\workspace", terminal: { executable: "pwsh.exe", arguments: ["-Command", "setup"] } },
          start,
          close,
          waitForRelease: async () => undefined,
        },
      });
      return pending.promise;
    });
    const instance = new WorkspaceEnvironmentService({
      mcodeDir: root,
      threads: {
        findById: (id) => ({
          id,
          workspace_id: id === "thread-workspace" ? "workspace-2" : workspaceId,
          mode: "direct",
        }),
      },
      terminalCommands: { prepare },
      platform: "windows",
      schedule: (callback) => {
        timers.push(callback);
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      cancelScheduled: vi.fn(),
    });
    for (const id of [workspaceId, "workspace-2"]) {
      await instance.save({ workspaceId: id, sourceRevision: null, document: { version: "0.0.1", setup: { windows: "setup" }, actions: [] } });
    }

    const threadStart = instance.startSetup({ threadId: "thread-thread" });
    const workspaceStart = instance.startSetup({ threadId: "thread-workspace" });
    const disposalStart = instance.startSetup({ threadId: "thread-dispose" });
    for (const start of [threadStart, workspaceStart, disposalStart]) void start.catch(() => undefined);
    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(3));

    const threadCancellation = instance.cancelSetupForThread("thread-thread");
    timers.shift()!();
    await expect(threadCancellation).resolves.toBeUndefined();
    const workspaceCancellation = instance.cancelSetupForWorkspace("workspace-2");
    timers.shift()!();
    await expect(workspaceCancellation).resolves.toBeUndefined();
    const disposal = instance.dispose();
    for (const timeout of timers.splice(0)) timeout();
    await expect(disposal).resolves.toBeUndefined();

    for (const threadId of ["thread-thread", "thread-workspace", "thread-dispose"]) {
      pendingByThread.get(threadId)!.resolve(commands.get(threadId)!);
    }
    await expect(threadStart).rejects.toThrow("Project Setup start was cancelled");
    await expect(workspaceStart).rejects.toThrow("Project Setup start was cancelled");
    await expect(disposalStart).rejects.toThrow("Project Setup start was cancelled");
    for (const threadId of ["thread-thread", "thread-workspace", "thread-dispose"]) {
      const command = commands.get(threadId);
      expect(command?.kind).toBe("ready");
      if (command?.kind !== "ready") continue;
      expect(command.command.close).toHaveBeenCalledTimes(1);
      expect(command.command.start).not.toHaveBeenCalled();
      expect(instance.getSetupAttempt({ threadId }).attempt).toBeNull();
    }
  });

  it("rejects excess pending Setup work and frees capacity after late cancellation cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcode-environment-setup-"));
    roots.push(root);
    const timers: Array<() => void> = [];
    const pendingByThread = new Map<string, ReturnType<typeof deferred<TerminalCommandPreparation>>>();
    const commands = new Map<string, TerminalCommandPreparation>();
    const prepare = vi.fn((input: { readonly scope: { readonly threadId: string } }) => {
      const pending = deferred<TerminalCommandPreparation>();
      const close = vi.fn(async () => ({ kind: "contained" as const }));
      pendingByThread.set(input.scope.threadId, pending);
      commands.set(input.scope.threadId, {
        kind: "ready",
        command: {
          snapshot: { checkoutPath: "C:\\workspace", terminal: { executable: "pwsh.exe", arguments: ["-Command", "setup"] } },
          start: vi.fn(async () => await new Promise<never>(() => undefined)),
          close,
          waitForRelease: async () => undefined,
        },
      });
      return pending.promise;
    });
    const instance = new WorkspaceEnvironmentService({
      mcodeDir: root,
      threads: { findById: (id) => ({ id, workspace_id: workspaceId, mode: "direct" }) },
      terminalCommands: { prepare },
      platform: "windows",
      schedule: (callback) => {
        timers.push(callback);
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      cancelScheduled: vi.fn(),
    });
    await instance.save({ workspaceId, sourceRevision: null, document: { version: "0.0.1", setup: { windows: "setup" }, actions: [] } });

    const starts = Array.from({ length: 8 }, (_, index) => instance.startSetup({ threadId: `thread-${index}` }));
    for (const start of starts) void start.catch(() => undefined);
    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(8));
    await expect(instance.startSetup({ threadId: "thread-capacity" })).rejects.toMatchObject({
      code: "WORKSPACE_ENVIRONMENT_SETUP_CAPACITY",
    });

    const cancellation = instance.cancelSetupForThread("thread-0");
    timers.shift()!();
    await expect(cancellation).resolves.toBeUndefined();
    pendingByThread.get("thread-0")!.resolve(commands.get("thread-0")!);
    await expect(starts[0]).rejects.toThrow("Project Setup start was cancelled");
    await waitFor(() => expect(commands.get("thread-0")?.kind === "ready" && commands.get("thread-0")?.command.close).toHaveBeenCalledTimes(1));

    const retry = instance.startSetup({ threadId: "thread-capacity" });
    void retry.catch(() => undefined);
    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(9));
  });

  it("waits for a pending environment read and prevents the cancelled Thread from preparing Setup", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcode-environment-setup-"));
    roots.push(root);
    const prepare = vi.fn();
    const instance = new WorkspaceEnvironmentService({
      mcodeDir: root,
      threads: { findById: (id) => id === "thread-reading" ? { id, workspace_id: workspaceId, mode: "direct" } : null },
      terminalCommands: { prepare },
      platform: "windows",
    });
    await instance.save({ workspaceId, sourceRevision: null, document: { version: "0.0.1", setup: { windows: "setup" }, actions: [] } });
    const pending = deferred<Awaited<ReturnType<WorkspaceEnvironmentService["read"]>>>();
    vi.spyOn(instance, "read").mockReturnValue(pending.promise);

    const starting = instance.startSetup({ threadId: "thread-reading" });
    void starting.catch(() => undefined);
    const cancellation = instance.cancelSetupForThread("thread-reading");
    let cancelled = false;
    void cancellation.then(() => { cancelled = true; });
    await Promise.resolve();
    expect(cancelled).toBe(false);

    pending.resolve({
      document: { version: "0.0.1", setup: { windows: "setup" }, actions: [] },
      revision: "current",
      status: "present",
    });

    await expect(cancellation).resolves.toBeUndefined();
    await expect(starting).rejects.toThrow("Project Setup start was cancelled");
    expect(prepare).not.toHaveBeenCalled();
    expect(instance.getSetupAttempt({ threadId: "thread-reading" }).attempt).toBeNull();
  });

  it("cancels pending preparations by workspace and during server disposal", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcode-environment-setup-"));
    roots.push(root);
    const pendingByThread = new Map<string, { readonly promise: Promise<TerminalCommandPreparation>; readonly resolve: (value: TerminalCommandPreparation) => void }>();
    const preparations = new Map<string, TerminalCommandPreparation>();
    const prepare = vi.fn((input: { readonly scope: { readonly threadId: string } }) => {
      const pending = deferred<TerminalCommandPreparation>();
      pendingByThread.set(input.scope.threadId, pending);
      const start = vi.fn(async () => await new Promise<never>(() => undefined));
      const close = vi.fn(async () => ({ kind: "contained" as const }));
      preparations.set(input.scope.threadId, {
        kind: "ready",
        command: {
          snapshot: { checkoutPath: "C:\\workspace", terminal: { executable: "pwsh.exe", arguments: ["-Command", "setup"] } },
          start,
          close,
          waitForRelease: async () => undefined,
        },
      });
      return pending.promise;
    });
    const instance = new WorkspaceEnvironmentService({
      mcodeDir: root,
      threads: {
        findById: (id) => ({
          id,
          workspace_id: id === "thread-workspace" ? "workspace-2" : workspaceId,
          mode: "direct",
        }),
      },
      terminalCommands: { prepare },
      platform: "windows",
    });
    for (const id of [workspaceId, "workspace-2"]) {
      await instance.save({ workspaceId: id, sourceRevision: null, document: { version: "0.0.1", setup: { windows: "setup" }, actions: [] } });
    }

    const workspaceStart = instance.startSetup({ threadId: "thread-workspace" });
    void workspaceStart.catch(() => undefined);
    await waitFor(() => expect(pendingByThread.get("thread-workspace")).toBeDefined());
    const workspaceCancellation = instance.cancelSetupForWorkspace("workspace-2");
    pendingByThread.get("thread-workspace")!.resolve(preparations.get("thread-workspace")!);
    await expect(workspaceCancellation).resolves.toBeUndefined();
    await expect(workspaceStart).rejects.toThrow("Project Setup start was cancelled");

    const disposalStart = instance.startSetup({ threadId: "thread-dispose" });
    void disposalStart.catch(() => undefined);
    await waitFor(() => expect(pendingByThread.get("thread-dispose")).toBeDefined());
    const disposal = instance.dispose();
    pendingByThread.get("thread-dispose")!.resolve(preparations.get("thread-dispose")!);
    await expect(disposal).resolves.toBeUndefined();
    await expect(disposalStart).rejects.toThrow("Project Setup start was cancelled");

    for (const threadId of ["thread-workspace", "thread-dispose"]) {
      const preparation = preparations.get(threadId);
      expect(preparation?.kind).toBe("ready");
      if (preparation?.kind !== "ready") continue;
      expect(preparation.command.close).toHaveBeenCalledTimes(1);
      expect(preparation.command.start).not.toHaveBeenCalled();
      expect(instance.getSetupAttempt({ threadId }).attempt).toBeNull();
    }
  });

  it("evicts the oldest completed transient attempts without evicting active Setup", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcode-environment-setup-"));
    roots.push(root);
    let nextAttempt = 0;
    const instance = new WorkspaceEnvironmentService({
      mcodeDir: root,
      threads: { findById: (id) => ({ id, workspace_id: workspaceId, mode: "direct" }) },
      terminalCommands: {
        prepare: async () => ({
          kind: "ready" as const,
          command: {
            snapshot: { checkoutPath: "C:\\workspace", terminal: { executable: "pwsh.exe", arguments: ["-Command", "setup"] } },
            start: async () => ({ kind: "exited" as const, exitCode: 0, output: "done", outputTruncated: false }),
            close: async () => ({ kind: "contained" as const }),
            waitForRelease: async () => undefined,
          },
        }),
      },
      platform: "windows",
      createAttemptId: () => `attempt-${nextAttempt++}`,
    });
    await instance.save({ workspaceId, sourceRevision: null, document: { version: "0.0.1", setup: { windows: "setup" }, actions: [] } });

    for (let index = 0; index < 33; index += 1) {
      await instance.startSetup({ threadId: `thread-${index}` });
      await Promise.resolve();
      await Promise.resolve();
    }

    expect(instance.getSetupAttempt({ threadId: "thread-0" }).attempt).toBeNull();
    expect(instance.getSetupAttempt({ threadId: "thread-32" }).attempt).toMatchObject({
      status: "passed",
      output: "done",
    });
  });
});
