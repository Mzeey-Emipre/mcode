import { describe, expect, it, vi } from "vitest";
import type { IDisposable, IPty } from "node-pty";
import type { PtyHostEvent } from "../pty-host-protocol.js";
import {
  PtyHostProcessRuntime,
  type PtyProcessScope,
} from "../pty-host-runtime.js";

const SESSION_ID = "abcdef12-abcd-4abc-8abc-abcdefabcdef";
const TEST_HOST_RUNTIME = { platform: "win32", architecture: "x64" } as const;

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
  it("runs a contained PTY through create, I/O, resize, inspection, and close", async () => {
    vi.useFakeTimers();
    const pty = new FakePty();
    const scope = createScope();
    const events: PtyHostEvent[] = [];
    const runtime = new PtyHostProcessRuntime({
      platform: "windows",
      hostRuntime: TEST_HOST_RUNTIME,
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
      hostRuntime: TEST_HOST_RUNTIME,
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
