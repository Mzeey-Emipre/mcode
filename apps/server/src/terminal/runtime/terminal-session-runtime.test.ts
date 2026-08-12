import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalLaunchSnapshot, TerminalScope } from "@mcode/contracts";
import type {
  PtyHostAdapter,
  PtyHostClose,
  PtyHostCommand,
  PtyHostCreate,
  PtyHostHealth,
  PtyHostRunning,
} from "../host/pty-host-adapter.js";
import type { PtyHostEvent } from "../host/pty-host-protocol.js";
import { InMemoryPtyHostAdapter } from "../testing/in-memory-pty-host-adapter.js";
import {
  ModernTerminalSessionRuntime,
  TerminalSessionRuntimeError,
} from "./terminal-session-runtime.js";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const ATTACHMENT_ID = "00000000-0000-4000-8000-000000000002";
const SECOND_ATTACHMENT_ID = "00000000-0000-4000-8000-000000000003";
const HYDRATION_IDS = [
  "00000000-0000-4000-8000-000000000004",
  "00000000-0000-4000-8000-000000000005",
];
const SCOPE: TerminalScope = {
  kind: "workspace",
  workspaceId: SESSION_ID,
};
const LAUNCH: TerminalLaunchSnapshot = {
  requestedProfileId: "automatic",
  resolvedProfile: {
    id: "certified:windows-cmd",
    name: "Command Prompt",
    executable: "cmd.exe",
    arguments: ["/Q"],
    source: "certified",
    platform: "windows",
  },
  scope: SCOPE,
  arguments: ["/Q"],
};
let runtimes: ModernTerminalSessionRuntime[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(runtimes.map((runtime) => runtime.shutdown()));
  runtimes = [];
});

class ManualPtyHostAdapter implements PtyHostAdapter {
  readonly commands: PtyHostCommand[] = [];
  readonly creates: PtyHostCreate[] = [];
  readonly closes: PtyHostClose[] = [];
  private readonly listeners = new Set<(event: PtyHostEvent) => void>();
  createFailure: Error | null = null;

  async start(): Promise<PtyHostHealth> {
    return { hostGeneration: "7", state: "healthy" };
  }

  async create(input: PtyHostCreate): Promise<PtyHostRunning> {
    this.creates.push(input);
    if (this.createFailure) throw this.createFailure;
    return {
      sessionId: input.sessionId,
      hostGeneration: input.hostGeneration,
      state: "running",
      containment: "job-object",
    };
  }

  async send(command: PtyHostCommand): Promise<void> {
    this.commands.push(command);
  }

  async inspectChildren(): Promise<{ hasChildren: boolean }> {
    return { hasChildren: false };
  }

  async close(input: PtyHostClose): Promise<void> {
    this.closes.push(input);
  }

  async shutdown(): Promise<void> {}

  subscribe(listener: (event: PtyHostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: PtyHostEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function setup() {
  const host = new ManualPtyHostAdapter();
  let hydrationIndex = 0;
  const runtime = new ModernTerminalSessionRuntime({
    host,
    now: () => new Date("2026-08-12T12:00:00.000Z"),
    createHydrationId: () => HYDRATION_IDS[hydrationIndex++]!,
    createCorrelationId: () => "corr-runtime-test",
  });
  runtimes.push(runtime);
  return { host, runtime };
}

async function createRunningSession(
  runtime: ModernTerminalSessionRuntime,
) {
  return runtime.createSession({
    sessionId: SESSION_ID,
    scope: SCOPE,
    launch: LAUNCH,
    hostGeneration: "7",
    cwd: "C:\\repo",
    protectedEnv: [],
  });
}

async function attach(
  runtime: ModernTerminalSessionRuntime,
  attachmentId = ATTACHMENT_ID,
) {
  return runtime.attach({
    sessionId: SESSION_ID,
    attachmentId,
    hostGeneration: "7",
    lastOutputSeq: "0",
    lastCommandSeq: "0",
    checkpointSeq: null,
  });
}

describe("ModernTerminalSessionRuntime", () => {
  it("publishes running only after the contained PTY is ready", async () => {
    const { host, runtime } = setup();

    const created = await createRunningSession(runtime);

    expect(host.creates).toEqual([
      expect.objectContaining({
        sessionId: SESSION_ID,
        hostGeneration: "7",
        cols: 80,
        rows: 24,
      }),
    ]);
    expect(created).toEqual({
      contractVersion: 1,
      sessionId: SESSION_ID,
      scope: SCOPE,
      state: "running",
      hostGeneration: "7",
      launch: LAUNCH,
      createdAt: "2026-08-12T12:00:00.000Z",
      lastCommandSeq: "0",
      lastOutputSeq: "0",
      exit: null,
      tombstone: false,
    });
  });

  it("removes a starting session when host creation fails", async () => {
    const { host, runtime } = setup();
    host.createFailure = new Error("host create failed");

    await expect(createRunningSession(runtime)).rejects.toMatchObject({
      code: "HOST_UNHEALTHY",
      retry: "NEW_SESSION",
      message: "The Terminal host is unhealthy",
    });

    expect(runtime.getSnapshot(SESSION_ID)).toBeNull();
  });

  it("maps malformed create input to the closed protocol failure", async () => {
    const { host, runtime } = setup();

    await expect(runtime.createSession({
      sessionId: "not-a-session",
      scope: SCOPE,
      launch: LAUNCH,
      hostGeneration: "7",
      cwd: "C:\\repo",
      protectedEnv: [],
    })).rejects.toMatchObject({ code: "PROTOCOL_MISMATCH", retry: "RESTART" });

    expect(host.creates).toHaveLength(0);
  });

  it.each([
    { cwd: "relative", protectedEnv: [] },
    { cwd: "C:\\repo", protectedEnv: [{ name: "BAD-NAME", value: "value" }] },
    { cwd: "C:\\repo", protectedEnv: [{ name: "VALUE", value: "x".repeat(8_193) }] },
  ])("rejects a launch outside the private host boundary", async (invalidLaunch) => {
    const { host, runtime } = setup();

    await expect(runtime.createSession({
      sessionId: SESSION_ID,
      scope: SCOPE,
      launch: LAUNCH,
      hostGeneration: "7",
      ...invalidLaunch,
    })).rejects.toMatchObject({ code: "PROTOCOL_MISMATCH", retry: "RESTART" });

    expect(host.creates).toHaveLength(0);
  });

  it("increments attachment epochs and revokes the prior controller", async () => {
    const { runtime } = setup();
    await createRunningSession(runtime);

    const first = await attach(runtime);
    const second = await attach(runtime, SECOND_ATTACHMENT_ID);

    expect(first).toMatchObject({ attachmentId: ATTACHMENT_ID, attachmentEpoch: "1" });
    expect(second).toMatchObject({ attachmentId: SECOND_ATTACHMENT_ID, attachmentEpoch: "2" });
    await expect(runtime.detach({
      sessionId: SESSION_ID,
      attachmentId: ATTACHMENT_ID,
      attachmentEpoch: "1",
      reason: "switch",
    })).rejects.toMatchObject({ code: "STALE_ATTACHMENT", retry: "SAFE_RETRY" });
  });

  it("forwards input and resize in one strict command sequence", async () => {
    const { host, runtime } = setup();
    await createRunningSession(runtime);
    await attach(runtime);

    await runtime.sendCommand({
      sessionId: SESSION_ID,
      hostGeneration: "7",
      attachmentEpoch: "1",
      commandSeq: "1",
      kind: "resize",
      data: { cols: 120, rows: 30 },
    });
    await runtime.sendCommand({
      sessionId: SESSION_ID,
      hostGeneration: "7",
      attachmentEpoch: "1",
      commandSeq: "2",
      kind: "input",
      data: new TextEncoder().encode("echo ready\r"),
    });

    expect(host.commands.map((command) => [command.commandSeq, command.kind])).toEqual([
      ["1", "resize"],
      ["2", "input"],
    ]);
    expect(runtime.getSnapshot(SESSION_ID)?.lastCommandSeq).toBe("0");

    host.emit({
      contractVersion: 1,
      kind: "commandAck",
      sessionId: SESSION_ID,
      hostGeneration: "7",
      attachmentEpoch: "1",
      appliedCommandSeq: "2",
      appliedOutputSeq: "0",
    });

    expect(runtime.getSnapshot(SESSION_ID)?.lastCommandSeq).toBe("2");
  });

  it("rejects stale generations, stale controllers, and command gaps before host mutation", async () => {
    const { host, runtime } = setup();
    await createRunningSession(runtime);
    await attach(runtime);

    await expect(runtime.sendCommand({
      sessionId: SESSION_ID,
      hostGeneration: "8",
      attachmentEpoch: "1",
      commandSeq: "1",
      kind: "input",
      data: new Uint8Array([0x61]),
    })).rejects.toMatchObject({ code: "STALE_HOST_GENERATION" });
    await expect(runtime.sendCommand({
      sessionId: SESSION_ID,
      hostGeneration: "7",
      attachmentEpoch: "2",
      commandSeq: "1",
      kind: "input",
      data: new Uint8Array([0x61]),
    })).rejects.toMatchObject({ code: "STALE_ATTACHMENT" });
    await expect(runtime.sendCommand({
      sessionId: SESSION_ID,
      hostGeneration: "7",
      attachmentEpoch: "1",
      commandSeq: "2",
      kind: "resize",
      data: { cols: 100, rows: 20 },
    })).rejects.toMatchObject({ code: "COMMAND_OUT_OF_ORDER" });

    expect(host.commands).toHaveLength(0);
  });

  it("bounds unacknowledged input and releases bytes through cumulative acknowledgements", async () => {
    const { host, runtime } = setup();
    await createRunningSession(runtime);
    await attach(runtime);
    const chunk = new Uint8Array(65_536);

    for (let sequence = 1; sequence <= 4; sequence += 1) {
      await runtime.sendCommand({
        sessionId: SESSION_ID,
        hostGeneration: "7",
        attachmentEpoch: "1",
        commandSeq: String(sequence),
        kind: "input",
        data: chunk,
      });
    }
    await expect(runtime.sendCommand({
      sessionId: SESSION_ID,
      hostGeneration: "7",
      attachmentEpoch: "1",
      commandSeq: "5",
      kind: "input",
      data: new Uint8Array([0x61]),
    })).rejects.toMatchObject({ code: "INPUT_STALLED" });

    host.emit({
      contractVersion: 1,
      kind: "commandAck",
      sessionId: SESSION_ID,
      hostGeneration: "7",
      attachmentEpoch: "1",
      appliedCommandSeq: "2",
      appliedOutputSeq: "0",
    });
    await runtime.sendCommand({
      sessionId: SESSION_ID,
      hostGeneration: "7",
      attachmentEpoch: "1",
      commandSeq: "5",
      kind: "input",
      data: new Uint8Array([0x61]),
    });

    expect(host.commands).toHaveLength(5);
  });

  it("bounds unacknowledged resize commands until a cumulative acknowledgement arrives", async () => {
    const { host, runtime } = setup();
    await createRunningSession(runtime);
    await attach(runtime);

    for (let sequence = 1; sequence <= 256; sequence += 1) {
      await runtime.sendCommand({
        sessionId: SESSION_ID,
        hostGeneration: "7",
        attachmentEpoch: "1",
        commandSeq: String(sequence),
        kind: "resize",
        data: { cols: 80 + (sequence % 2), rows: 24 },
      });
    }
    await expect(runtime.sendCommand({
      sessionId: SESSION_ID,
      hostGeneration: "7",
      attachmentEpoch: "1",
      commandSeq: "257",
      kind: "resize",
      data: { cols: 100, rows: 30 },
    })).rejects.toMatchObject({ code: "INPUT_STALLED" });

    host.emit({
      contractVersion: 1,
      kind: "commandAck",
      sessionId: SESSION_ID,
      hostGeneration: "7",
      attachmentEpoch: "1",
      appliedCommandSeq: "256",
      appliedOutputSeq: "0",
    });
    await expect(runtime.sendCommand({
      sessionId: SESSION_ID,
      hostGeneration: "7",
      attachmentEpoch: "1",
      commandSeq: "257",
      kind: "resize",
      data: { cols: 100, rows: 30 },
    })).resolves.toBeUndefined();
  });

  it("revokes a controller whose input acknowledgement stalls for two seconds", async () => {
    vi.useFakeTimers();
    try {
      const { host, runtime } = setup();
      await createRunningSession(runtime);
      await attach(runtime);
      await runtime.sendCommand({
        sessionId: SESSION_ID,
        hostGeneration: "7",
        attachmentEpoch: "1",
        commandSeq: "1",
        kind: "input",
        data: new Uint8Array([0x61]),
      });

      await vi.advanceTimersByTimeAsync(2_000);

      await expect(runtime.sendCommand({
        sessionId: SESSION_ID,
        hostGeneration: "7",
        attachmentEpoch: "1",
        commandSeq: "2",
        kind: "input",
        data: new Uint8Array([0x62]),
      })).rejects.toMatchObject({
        code: "INPUT_DELIVERY_UNKNOWN",
        retry: "UNKNOWN_DELIVERY",
      });
      host.emit({
        contractVersion: 1,
        kind: "commandAck",
        sessionId: SESSION_ID,
        hostGeneration: "7",
        attachmentEpoch: "1",
        appliedCommandSeq: "1",
        appliedOutputSeq: "0",
      });
      const next = await attach(runtime, SECOND_ATTACHMENT_ID);
      await expect(runtime.sendCommand({
        sessionId: SESSION_ID,
        hostGeneration: "7",
        attachmentEpoch: next.attachmentEpoch,
        commandSeq: "2",
        kind: "input",
        data: new Uint8Array([0x62]),
      })).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts only cumulative output acknowledgements for received output", async () => {
    const { host, runtime } = setup();
    await createRunningSession(runtime);
    await attach(runtime);
    host.emit({
      contractVersion: 1,
      kind: "output",
      sessionId: SESSION_ID,
      hostGeneration: "7",
      outputSeq: "1",
      dataBase64: Buffer.from("ready").toString("base64"),
    });

    runtime.acknowledgeOutput({
      sessionId: SESSION_ID,
      hostGeneration: "7",
      attachmentEpoch: "1",
      outputSeq: "1",
    });
    expect(runtime.getSnapshot(SESSION_ID)?.lastOutputSeq).toBe("1");
    expect(() => runtime.acknowledgeOutput({
      sessionId: SESSION_ID,
      hostGeneration: "7",
      attachmentEpoch: "1",
      outputSeq: "2",
    })).toThrow(TerminalSessionRuntimeError);
  });

  it("runs the lifecycle and close barrier through the in-memory host seam", async () => {
    const host = new InMemoryPtyHostAdapter("7");
    await host.start();
    const runtime = new ModernTerminalSessionRuntime({
      host,
      now: () => new Date("2026-08-12T12:00:00.000Z"),
      createHydrationId: () => HYDRATION_IDS[0]!,
      createCorrelationId: () => "corr-runtime-test",
    });
    runtimes.push(runtime);
    await createRunningSession(runtime);
    await attach(runtime);

    await runtime.sendCommand({
      sessionId: SESSION_ID,
      hostGeneration: "7",
      attachmentEpoch: "1",
      commandSeq: "1",
      kind: "resize",
      data: { cols: 100, rows: 25 },
    });
    expect(runtime.getSnapshot(SESSION_ID)?.lastCommandSeq).toBe("1");

    const closed = await runtime.close({ sessionId: SESSION_ID, reason: "user" });

    expect(closed).toMatchObject({
      state: "exited",
      tombstone: true,
      exit: { code: 0, signal: null, reason: "user-close" },
    });
    await expect(runtime.sendCommand({
      sessionId: SESSION_ID,
      hostGeneration: "7",
      attachmentEpoch: "1",
      commandSeq: "2",
      kind: "input",
      data: new Uint8Array([0x61]),
    })).rejects.toMatchObject({ code: "SESSION_NOT_RUNNING" });
  });
});
