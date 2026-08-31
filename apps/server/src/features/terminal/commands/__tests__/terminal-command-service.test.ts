import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { getDefaultSettings, type TerminalResolvedProfile } from "@mcode/contracts";
import {
  TerminalCommandService,
  noninteractiveLaunch,
  type TerminalCommandProcess,
} from "../terminal-command-service.js";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const threadId = "00000000-0000-4000-8000-000000000002";
const profile: TerminalResolvedProfile = {
  id: "certified:windows-powershell-7",
  name: "PowerShell",
  executable: "pwsh.exe",
  arguments: ["-ExecutionPolicy", "Bypass"],
  source: "certified",
  platform: "windows",
};

function childProcess(): TerminalCommandProcess & EventEmitter {
  const child = new EventEmitter() as TerminalCommandProcess & EventEmitter;
  Object.assign(child, {
    pid: 421,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  return child;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function service(overrides: Partial<ConstructorParameters<typeof TerminalCommandService>[0]> = {}) {
  const spawned = childProcess();
  const spawn = vi.fn(() => spawned);
  const settings = getDefaultSettings();
  return {
    spawned,
    spawn,
    service: new TerminalCommandService({
      platform: "win32",
      profiles: {
        resolveLaunchProfile: vi.fn(async () => ({
          requestedProfileId: "automatic" as const,
          resolvedProfile: profile,
        })),
      },
      env: { getEnv: vi.fn(() => ({ PATH: "safe", SECRET: "hidden" })) },
      settings: { get: () => settings },
      workspaces: { findById: (id) => id === workspaceId ? { id, path: "C:\\workspace" } : null },
      threads: { findById: (id) => id === threadId ? { id, workspace_id: workspaceId, mode: "direct", worktree_path: null } : null },
      resolveWorkingDir: (path) => path,
      validateWorkingDirectory: () => true,
      spawn,
      ...overrides,
    }),
  };
}

describe("TerminalCommandService", () => {
  it("passes a Setup script through PowerShell noninteractive arguments with closed stdin", async () => {
    const { service: commands, spawn, spawned } = service();
    const prepared = await commands.prepare({
      scope: { kind: "thread", workspaceId, threadId },
      script: "bun run setup",
      timeoutMs: 1_000,
    });
    expect(prepared.kind).toBe("ready");
    if (prepared.kind !== "ready") return;

    const completion = prepared.command.start();
    expect(spawn).toHaveBeenCalledWith(
      "pwsh.exe",
      ["-ExecutionPolicy", "Bypass", "-NoLogo", "-NonInteractive", "-Command", "bun run setup"],
      expect.objectContaining({ cwd: "C:\\workspace", stdio: ["ignore", "pipe", "pipe"], shell: false }),
    );
    (spawned.stdout as EventEmitter).emit("data", Buffer.from("prepared\n"));
    spawned.emit("close", 0);
    await expect(completion).resolves.toEqual({
      kind: "exited",
      exitCode: 0,
      output: "prepared\n",
      outputTruncated: false,
    });
  });

  it("records a one-shot command before it can run and removes the record after normal exit", async () => {
    const pidRegistry = {
      register: vi.fn(),
      deregister: vi.fn(),
    };
    const { service: commands, spawned } = service({
      pidRegistry,
      createCommandId: () => "command-1",
    });
    const prepared = await commands.prepare({
      scope: { kind: "thread", workspaceId, threadId },
      script: "bun run setup",
      timeoutMs: 1_000,
    });
    expect(prepared.kind).toBe("ready");
    if (prepared.kind !== "ready") return;

    const completion = prepared.command.start();
    expect(pidRegistry.register).toHaveBeenCalledWith("terminal-command:command-1", 421, "pwsh.exe");
    expect(pidRegistry.deregister).not.toHaveBeenCalled();
    spawned.emit("close", 0);

    await expect(completion).resolves.toMatchObject({ kind: "exited", exitCode: 0 });
    expect(pidRegistry.deregister).toHaveBeenCalledWith("terminal-command:command-1");
  });

  it("keeps unsupported shell construction in Terminal policy", async () => {
    expect(noninteractiveLaunch({ ...profile, executable: "custom-terminal.exe" }, "bun run setup")).toBeNull();
    const { service: commands } = service({
      profiles: {
        resolveLaunchProfile: vi.fn(async () => ({
          requestedProfileId: "automatic" as const,
          resolvedProfile: { ...profile, executable: "custom-terminal.exe" },
        })),
      },
    });
    await expect(commands.prepare({
      scope: { kind: "thread", workspaceId, threadId },
      script: "bun run setup",
      timeoutMs: 1_000,
    })).resolves.toMatchObject({ kind: "configuration" });
  });

  it("classifies an executable launch failure without retaining the environment", async () => {
    const { service: commands } = service({
      spawn: vi.fn(() => { throw new Error("executable missing"); }),
    });
    const prepared = await commands.prepare({
      scope: { kind: "thread", workspaceId, threadId },
      script: "bun run setup",
      timeoutMs: 1_000,
    });
    expect(prepared.kind).toBe("ready");
    if (prepared.kind !== "ready") return;

    await expect(prepared.command.start()).resolves.toEqual({
      kind: "launch_failure",
      output: "",
      outputTruncated: false,
    });
    expect(JSON.stringify(prepared.command.snapshot)).not.toContain("hidden");
  });

  it("bounds retained Setup output through the Terminal replay buffer", async () => {
    const { service: commands, spawned } = service();
    const prepared = await commands.prepare({
      scope: { kind: "thread", workspaceId, threadId },
      script: "bun run setup",
      timeoutMs: 1_000,
      outputMaxBytes: 65_536,
    });
    expect(prepared.kind).toBe("ready");
    if (prepared.kind !== "ready") return;

    const completion = prepared.command.start();
    (spawned.stdout as EventEmitter).emit("data", Buffer.alloc(40_000, "a"));
    (spawned.stdout as EventEmitter).emit("data", Buffer.alloc(40_000, "b"));
    spawned.emit("close", 0);

    await expect(completion).resolves.toEqual({
      kind: "exited",
      exitCode: 0,
      output: "b".repeat(40_000),
      outputTruncated: true,
    });
  });

  it("uses the resolved worktree checkout for a worktree Thread", async () => {
    const resolveWorkingDir = vi.fn(() => "C:\\worktree");
    const { service: commands } = service({
      threads: {
        findById: (id) => id === threadId
          ? { id, workspace_id: workspaceId, mode: "worktree", worktree_path: "C:\\worktree" }
          : null,
      },
      resolveWorkingDir,
    });
    const prepared = await commands.prepare({
      scope: { kind: "thread", workspaceId, threadId },
      script: "bun run setup",
      timeoutMs: 1_000,
    });
    expect(prepared).toMatchObject({ kind: "ready", command: { snapshot: { checkoutPath: "C:\\worktree" } } });
    expect(resolveWorkingDir).toHaveBeenCalledWith("C:\\workspace", "worktree", "C:\\worktree");
  });

  it("contains a timed-out command tree and returns a timeout result", async () => {
    let timeoutCallback!: () => void;
    const killProcessTree = vi.fn().mockResolvedValue(undefined);
    const { service: commands, spawned } = service({
      killProcessTree,
      setTimeout: vi.fn((callback) => {
        timeoutCallback = callback;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }),
      clearTimeout: vi.fn(),
    });
    const prepared = await commands.prepare({
      scope: { kind: "thread", workspaceId, threadId },
      script: "bun run setup",
      timeoutMs: 1_000,
    });
    expect(prepared.kind).toBe("ready");
    if (prepared.kind !== "ready") return;

    const completion = prepared.command.start();
    timeoutCallback();
    await Promise.resolve();
    expect(killProcessTree).toHaveBeenCalledWith(421);
    spawned.emit("close", null);
    await expect(completion).resolves.toEqual({ kind: "timeout", output: "", outputTruncated: false });
  });

  it("keeps ownership when the root child closes before containment rejects, then retries containment", async () => {
    const callbacks: Array<() => void> = [];
    const firstContainment = deferred<void>();
    const killProcessTree = vi.fn()
      .mockImplementationOnce(() => firstContainment.promise)
      .mockResolvedValueOnce(undefined);
    const { service: commands, spawned } = service({
      killProcessTree,
      setTimeout: vi.fn((callback) => {
        callbacks.push(callback);
        return callbacks.length as unknown as ReturnType<typeof setTimeout>;
      }),
      clearTimeout: vi.fn(),
    });
    const prepared = await commands.prepare({
      scope: { kind: "thread", workspaceId, threadId },
      script: "bun run setup",
      timeoutMs: 1_000,
    });
    expect(prepared.kind).toBe("ready");
    if (prepared.kind !== "ready") return;

    const completion = prepared.command.start();
    callbacks[0]!();
    await Promise.resolve();
    expect(killProcessTree).toHaveBeenCalledTimes(1);
    let released = false;
    void prepared.command.waitForRelease().then(() => { released = true; });
    spawned.emit("close", null);
    const beforeContainment = await Promise.race([
      completion,
      Promise.resolve().then(() => Promise.resolve()).then(() => "still-pending" as const),
    ]);
    expect(beforeContainment).toBe("still-pending");

    firstContainment.reject(new Error("containment failed"));
    await expect(completion).resolves.toEqual({ kind: "containment_failure", output: "", outputTruncated: false });
    await Promise.resolve();
    expect(released).toBe(false);

    await expect(prepared.command.close()).resolves.toEqual({ kind: "contained" });
    expect(killProcessTree).toHaveBeenCalledTimes(2);
    await prepared.command.waitForRelease();
    expect(released).toBe(true);
  });

  it("waits for the normal containment verifier instead of timing a close independently", async () => {
    const containment = deferred<void>();
    const scheduled: Array<{ readonly callback: () => void; readonly delay: number }> = [];
    const killProcessTree = vi.fn(() => containment.promise);
    const { service: commands } = service({
      killProcessTree,
      setTimeout: vi.fn((callback, delay) => {
        scheduled.push({ callback, delay });
        return scheduled.length as unknown as ReturnType<typeof setTimeout>;
      }),
      clearTimeout: vi.fn(),
    });
    const prepared = await commands.prepare({
      scope: { kind: "thread", workspaceId, threadId },
      script: "bun -e \"await Bun.sleep(120000)\"",
      timeoutMs: 120_000,
    });
    expect(prepared.kind).toBe("ready");
    if (prepared.kind !== "ready") return;

    const completion = prepared.command.start();
    const closing = prepared.command.close();
    await Promise.resolve();

    expect(killProcessTree).toHaveBeenCalledWith(421);
    expect(scheduled.map(({ delay }) => delay)).toEqual([120_000]);

    containment.resolve();
    await expect(closing).resolves.toEqual({ kind: "contained" });
    await expect(completion).resolves.toEqual({
      kind: "launch_failure",
      output: "",
      outputTruncated: false,
    });
  });

  it("cancels a running command once and waits for verified containment", async () => {
    const killProcessTree = vi.fn().mockResolvedValue(undefined);
    const pidRegistry = {
      register: vi.fn(),
      deregister: vi.fn(),
    };
    const { service: commands } = service({
      killProcessTree,
      pidRegistry,
      createCommandId: () => "command-2",
    });
    const prepared = await commands.prepare({
      scope: { kind: "thread", workspaceId, threadId },
      script: "bun run setup",
      timeoutMs: 1_000,
    });
    expect(prepared.kind).toBe("ready");
    if (prepared.kind !== "ready") return;

    const completion = prepared.command.start();
    const first = prepared.command.close();
    const second = prepared.command.close();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { kind: "contained" },
      { kind: "contained" },
    ]);
    expect(killProcessTree).toHaveBeenCalledTimes(1);
    expect(pidRegistry.deregister).toHaveBeenCalledWith("terminal-command:command-2");
    await expect(completion).resolves.toEqual({
      kind: "launch_failure",
      output: "",
      outputTruncated: false,
    });
  });
});
