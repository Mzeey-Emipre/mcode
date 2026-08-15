import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IDisposable, IPty } from "node-pty";
import type { PtyHostEvent } from "./pty-host-protocol.js";

const { nativeRequire } = vi.hoisted(() => {
  const nativeSpawn = vi.fn() as unknown as typeof import("node-pty").spawn;
  const nativeRequire = vi.fn((moduleName: string) => {
    if (moduleName === "node-pty") return { spawn: nativeSpawn };
    throw new Error(`Missing native test module: ${moduleName}`);
  });
  return { nativeRequire };
});

vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  return { ...actual, createRequire: () => nativeRequire };
});

import {
  PtyHostNativeLoadError,
  PtyHostProcessRuntime,
  type PtyProcessScope,
} from "./pty-host-runtime.js";

const SESSION_ID = "abcdef12-abcd-4abc-8abc-abcdefabcdef";

class FakePty implements IPty {
  readonly pid = 123;
  readonly cols = 80;
  readonly rows = 24;
  readonly process = "pwsh.exe";
  handleFlowControl = false;
  private dataListener: ((data: string) => void) | null = null;
  private exitListener:
    ((event: { exitCode: number; signal?: number }) => void) | null = null;
  readonly write = vi.fn();
  readonly resize = vi.fn();
  readonly pause = vi.fn();
  readonly resume = vi.fn();
  readonly clear = vi.fn();
  readonly kill = vi.fn();

  readonly onData = (listener: (data: string) => void): IDisposable => {
    this.dataListener = listener;
    return {
      dispose: () => {
        this.dataListener = null;
      },
    };
  };

  readonly onExit = (
    listener: (event: { exitCode: number; signal?: number }) => void,
  ): IDisposable => {
    this.exitListener = listener;
    return {
      dispose: () => {
        this.exitListener = null;
      },
    };
  };

  emitData(data: string): void {
    this.dataListener?.(data);
  }

  emitExit(exitCode = 0): void {
    this.exitListener?.({ exitCode });
  }
}

function createScope(established = true): PtyProcessScope {
  return {
    mechanism: "job-object",
    processGroupId: "job-123",
    establish: vi.fn(async () => established),
    hasChildren: vi.fn(async () => false),
    close: vi.fn(async () => undefined),
    dispose: vi.fn(),
  };
}

describe("PtyHostProcessRuntime", () => {
  beforeEach(() => {
    nativeRequire.mockClear();
  });

  it("validates native spawn before publishing ready when spawn is not injected", async () => {
    const events: PtyHostEvent[] = [];
    const runtime = new PtyHostProcessRuntime({
      platform: "windows",
      nativeAbi: "fake-v1",
      publish: (event) => events.push(event),
    });

    await runtime.receive({
      contractVersion: 1,
      kind: "handshake",
      requestedGeneration: "7",
      platform: "windows",
    });

    expect(nativeRequire).toHaveBeenCalledWith("node-pty");
    expect(events[0]).toMatchObject({ kind: "ready" });
    await runtime.dispose();
  });

  it("fails before ready for the protected startup faults", async () => {
    const events: PtyHostEvent[] = [];
    const runtime = new PtyHostProcessRuntime({
      platform: "windows",
      nativeAbi: "fake-v1",
      publish: (event) => events.push(event),
    });

    await expect(
      runtime.receive({
        contractVersion: 1,
        kind: "handshake",
        requestedGeneration: "7",
        platform: "windows",
        releaseTestFault: "startup-health-failure",
      }),
    ).rejects.toThrow("startup-health-failure");
    expect(events).toEqual([]);
    await runtime.dispose();
  });

  it("reports missing native artifacts through the native-load failure seam", async () => {
    const events: PtyHostEvent[] = [];
    const runtime = new PtyHostProcessRuntime({
      platform: "windows",
      nativeAbi: "fake-v1",
      publish: (event) => events.push(event),
    });

    await expect(
      runtime.receive({
        contractVersion: 1,
        kind: "handshake",
        requestedGeneration: "7",
        platform: "windows",
        releaseTestFault: "missing-native-artifact",
      }),
    ).rejects.toBeInstanceOf(PtyHostNativeLoadError);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "failure",
      boundary: "startup",
      code: "HOST_UNHEALTHY",
    }));
    expect(events).not.toContainEqual(expect.objectContaining({ kind: "ready" }));
    expect(nativeRequire).toHaveBeenCalledWith(
      "node-pty/__mcode_missing_release_native_artifact__",
    );
    await runtime.dispose();
  });

  it("forces containment failure through the typed host seam", async () => {
    const pty = new FakePty();
    const scope = createScope(true);
    const events: PtyHostEvent[] = [];
    const onPostStartHostExit = vi.fn();
    const runtime = new PtyHostProcessRuntime({
      platform: "windows",
      nativeAbi: "fake-v1",
      publish: (event) => events.push(event),
      spawnPty: () => pty,
      createScope: () => scope,
      onPostStartHostExit,
    });
    await runtime.receive({
      contractVersion: 1,
      kind: "handshake",
      requestedGeneration: "7",
      platform: "windows",
      releaseTestFault: "containment-failure",
    });
    await runtime.receive({
      contractVersion: 1,
      kind: "create",
      sessionId: SESSION_ID,
      hostGeneration: "7",
      scope: { kind: "workspace", workspaceId: SESSION_ID },
      executable: "pwsh.exe",
      arguments: [],
      cwd: "C:\\repo",
      cols: 80,
      rows: 24,
      env: [],
    });
    expect(events).toContainEqual(expect.objectContaining({ kind: "failure", boundary: "containment" }));
    expect(onPostStartHostExit).toHaveBeenCalledOnce();
    await runtime.dispose();
  });

  it("requests host exit once after the first post-start session", async () => {
    vi.useFakeTimers();
    const pty = new FakePty();
    const scope = createScope(true);
    const onPostStartHostExit = vi.fn();
    const runtime = new PtyHostProcessRuntime({
      platform: "windows",
      nativeAbi: "fake-v1",
      publish: () => undefined,
      spawnPty: () => pty,
      createScope: () => scope,
      onPostStartHostExit,
    });
    await runtime.receive({
      contractVersion: 1,
      kind: "handshake",
      requestedGeneration: "7",
      platform: "windows",
      releaseTestFault: "post-start-host-exit",
    });
    await runtime.receive({
      contractVersion: 1,
      kind: "create",
      sessionId: SESSION_ID,
      hostGeneration: "7",
      scope: { kind: "workspace", workspaceId: SESSION_ID },
      executable: "pwsh.exe",
      arguments: [],
      cwd: "C:\\repo",
      cols: 80,
      rows: 24,
      env: [],
    });
    await vi.runOnlyPendingTimersAsync();
    expect(onPostStartHostExit).toHaveBeenCalledOnce();
    await runtime.dispose();
    vi.useRealTimers();
  });

  it("runs a contained PTY through create, I/O, resize, inspection, and close", async () => {
    vi.useFakeTimers();
    const pty = new FakePty();
    const scope = createScope();
    const events: PtyHostEvent[] = [];
    const runtime = new PtyHostProcessRuntime({
      platform: "windows",
      nativeAbi: "fake-v1",
      publish: (event) => events.push(event),
      spawnPty: vi.fn(() => pty),
      createScope: vi.fn(() => scope),
    });

    await runtime.receive({
      contractVersion: 1,
      kind: "handshake",
      requestedGeneration: "7",
      platform: "windows",
    });
    await runtime.receive({
      contractVersion: 1,
      kind: "create",
      sessionId: SESSION_ID,
      hostGeneration: "7",
      scope: { kind: "workspace", workspaceId: SESSION_ID },
      executable: "pwsh.exe",
      arguments: [],
      cwd: "C:\\repo",
      cols: 80,
      rows: 24,
      env: [],
    });
    expect(events.map((event) => event.kind).slice(0, 3)).toEqual([
      "ready",
      "containment",
      "running",
    ]);

    await runtime.receive({
      contractVersion: 1,
      kind: "command.input",
      sessionId: SESSION_ID,
      hostGeneration: "7",
      attachmentEpoch: "1",
      commandSeq: "1",
      dataBase64: Buffer.from("echo ok\r").toString("base64"),
    });
    await runtime.receive({
      contractVersion: 1,
      kind: "command.resize",
      sessionId: SESSION_ID,
      hostGeneration: "7",
      attachmentEpoch: "1",
      commandSeq: "2",
      cols: 100,
      rows: 30,
    });
    pty.emitData("ok\r\n");
    expect(pty.write).toHaveBeenCalledWith(Buffer.from("echo ok\r"));
    expect(pty.resize).toHaveBeenCalledWith(100, 30);
    expect(events.map((event) => event.kind)).toContain("output");

    await runtime.receive({
      contractVersion: 1,
      kind: "inspectChildren",
      sessionId: SESSION_ID,
      hostGeneration: "7",
    });
    expect(scope.hasChildren).toHaveBeenCalledOnce();
    expect(events.at(-1)).toEqual({
      contractVersion: 1,
      kind: "children",
      sessionId: SESSION_ID,
      hostGeneration: "7",
      hasChildren: false,
    });

    const close = runtime.receive({
      contractVersion: 1,
      kind: "close",
      sessionId: SESSION_ID,
      hostGeneration: "7",
      closeSeq: "3",
      reason: "user",
    });
    pty.emitExit();
    await close;
    expect(scope.close).toHaveBeenCalledOnce();
    expect(events.at(-1)).toMatchObject({ kind: "exit", reason: "user-close" });
    await runtime.dispose();
    vi.useRealTimers();
  });

  it("fails closed when authoritative containment cannot be established", async () => {
    const pty = new FakePty();
    const scope = createScope(false);
    const events: PtyHostEvent[] = [];
    const runtime = new PtyHostProcessRuntime({
      platform: "windows",
      nativeAbi: "fake-v1",
      publish: (event) => events.push(event),
      spawnPty: () => pty,
      createScope: () => scope,
    });
    await runtime.receive({
      contractVersion: 1,
      kind: "handshake",
      requestedGeneration: "7",
      platform: "windows",
    });

    await runtime.receive({
      contractVersion: 1,
      kind: "create",
      sessionId: SESSION_ID,
      hostGeneration: "7",
      scope: { kind: "workspace", workspaceId: SESSION_ID },
      executable: "pwsh.exe",
      arguments: [],
      cwd: "C:\\repo",
      cols: 80,
      rows: 24,
      env: [],
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "containment",
        established: false,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "failure",
        boundary: "containment",
        code: "CONTAINMENT_FAILED",
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({ kind: "running" }),
    );
    expect(scope.close).toHaveBeenCalledOnce();
    await runtime.dispose();
  });
});
