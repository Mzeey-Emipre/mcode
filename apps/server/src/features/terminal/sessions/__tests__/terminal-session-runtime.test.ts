import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalLaunchSnapshot, TerminalScope } from "@mcode/contracts";
import type {
  PtyHostAdapter,
  PtyHostClose,
  PtyHostCommand,
  PtyHostCreate,
  PtyHostHealth,
  PtyHostRunning,
} from "../../host/pty-host-adapter.js";
import type { PtyHostEvent } from "../../host/pty-host-protocol.js";
import { InMemoryPtyHostAdapter } from "../../testing/in-memory-pty-host-adapter.js";
import {
  ModernTerminalSessionRuntime,
  TerminalSessionRuntimeError,
} from "../terminal-session-runtime.js";

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
  createAction: ((input: PtyHostCreate) => Promise<void> | void) | null = null;
  closeAction: ((input: PtyHostClose) => Promise<void> | void) | null = null;

  async start(): Promise<PtyHostHealth> {
    return { hostGeneration: "7", state: "healthy" };
  }

  async create(input: PtyHostCreate): Promise<PtyHostRunning> {
    this.creates.push(input);
    if (this.createFailure) throw this.createFailure;
    await this.createAction?.(input);
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
    await this.closeAction?.(input);
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

function setup(replayCapacityBytes?: number) {
  const host = new ManualPtyHostAdapter();
  let hydrationIndex = 0;
  const runtime = new ModernTerminalSessionRuntime({
    host,
    now: () => new Date("2026-08-12T12:00:00.000Z"),
    createHydrationId: () => HYDRATION_IDS[hydrationIndex++]!,
    createCorrelationId: () => "corr-runtime-test",
    replayCapacityBytes,
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
  const descriptor = await runtime.attach({
    sessionId: SESSION_ID,
    attachmentId,
    hostGeneration: "7",
    lastOutputSeq: "0",
    lastCommandSeq: "0",
    checkpointSeq: null,
  });
  const hydration = runtime.consumeHydration({
    sessionId: SESSION_ID,
    hostGeneration: "7",
    attachmentEpoch: descriptor.attachmentEpoch,
    hydrationId: descriptor.hydrationId,
  });
  runtime.acknowledgeOutput({
    sessionId: SESSION_ID,
    hostGeneration: "7",
    attachmentEpoch: descriptor.attachmentEpoch,
    outputSeq:
      hydration.descriptor.lastOutputSeq ??
      hydration.descriptor.checkpointThroughSeq ??
      hydration.descriptor.requestedAfterSeq,
  });
  return descriptor;
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

  it("retains output emitted while host creation is still resolving", async () => {
    const { host, runtime } = setup();
    host.createAction = (input) => {
      host.emit({
        contractVersion: 1,
        kind: "output",
        sessionId: input.sessionId,
        hostGeneration: input.hostGeneration,
        outputSeq: "1",
        dataBase64: Buffer.from("initial prompt").toString("base64"),
      });
    };

    await createRunningSession(runtime);
    host.emit({
      contractVersion: 1,
      kind: "output",
      sessionId: SESSION_ID,
      hostGeneration: "7",
      outputSeq: "2",
      dataBase64: Buffer.from("shell output").toString("base64"),
    });

    const attachment = await runtime.attach({
      sessionId: SESSION_ID,
      attachmentId: ATTACHMENT_ID,
      hostGeneration: "7",
      lastOutputSeq: "0",
      lastCommandSeq: "0",
      checkpointSeq: null,
    });
    const hydration = runtime.consumeHydration({
      sessionId: SESSION_ID,
      hostGeneration: "7",
      attachmentEpoch: attachment.attachmentEpoch,
      hydrationId: attachment.hydrationId,
    });
    expect(hydration.descriptor).toMatchObject({
      mode: "delta",
      requestedAfterSeq: "0",
      lastOutputSeq: "2",
    });
    expect(hydration.output.map((chunk) => chunk.outputSeq)).toEqual(["1", "2"]);
    expect(Buffer.concat(hydration.output.map((chunk) => Buffer.from(chunk.data))).toString())
      .toBe("initial promptshell output");
    runtime.acknowledgeOutput({
      sessionId: SESSION_ID,
      hostGeneration: "7",
      attachmentEpoch: attachment.attachmentEpoch,
      outputSeq: "2",
    });
    expect(runtime.getSnapshot(SESSION_ID)).toMatchObject({
      state: "running",
      lastOutputSeq: "2",
    });
  });

  it("preserves a protocol-failure tombstone from invalid startup output", async () => {
    const { host, runtime } = setup();
    host.createAction = (input) => {
      host.emit({
        contractVersion: 1,
        kind: "output",
        sessionId: input.sessionId,
        hostGeneration: input.hostGeneration,
        outputSeq: "2",
        dataBase64: Buffer.from("invalid startup output").toString("base64"),
      });
    };

    await expect(createRunningSession(runtime)).resolves.toMatchObject({
      state: "failed",
      lastOutputSeq: "0",
      exit: { code: null, signal: null, reason: "protocol-failure" },
      tombstone: true,
    });
    expect(runtime.getSnapshot(SESSION_ID)).toMatchObject({
      state: "failed",
      exit: { reason: "protocol-failure" },
      tombstone: true,
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

  it("retains output emitted while host creation is resolving", async () => {
    const { host, runtime } = setup();
    host.createAction = () => {
      host.emit({
        contractVersion: 1,
        kind: "output",
        sessionId: SESSION_ID,
        hostGeneration: "7",
        outputSeq: "1",
        dataBase64: Buffer.from("initial output").toString("base64"),
      });
    };

    const created = await createRunningSession(runtime);

    expect(created.lastOutputSeq).toBe("1");
    const descriptor = await runtime.attach({
      sessionId: SESSION_ID,
      attachmentId: ATTACHMENT_ID,
      hostGeneration: "7",
      lastOutputSeq: "0",
      lastCommandSeq: "0",
      checkpointSeq: null,
    });
    const hydration = runtime.consumeHydration({
      sessionId: SESSION_ID,
      hostGeneration: "7",
      attachmentEpoch: descriptor.attachmentEpoch,
      hydrationId: descriptor.hydrationId,
    });

    expect(hydration.output).toEqual([
      {
        outputSeq: "1",
        data: Uint8Array.from(Buffer.from("initial output")),
      },
    ]);
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

  it("retains headless output and prepares a contiguous delta for reattachment", async () => {
    const { host, runtime } = setup();
    await createRunningSession(runtime);
    host.emit({
      contractVersion: 1,
      kind: "output",
      sessionId: SESSION_ID,
      hostGeneration: "7",
      outputSeq: "1",
      dataBase64: Buffer.from("first").toString("base64"),
    });
    host.emit({
      contractVersion: 1,
      kind: "output",
      sessionId: SESSION_ID,
      hostGeneration: "7",
      outputSeq: "2",
      dataBase64: Buffer.from("second").toString("base64"),
    });

    const descriptor = await runtime.attach({
      sessionId: SESSION_ID,
      attachmentId: ATTACHMENT_ID,
      hostGeneration: "7",
      lastOutputSeq: "1",
      lastCommandSeq: "0",
      checkpointSeq: null,
    });
    runtime.acknowledgeOutput({
      sessionId: SESSION_ID,
      hostGeneration: "7",
      attachmentEpoch: descriptor.attachmentEpoch,
      outputSeq: "2",
    });
    const hydration = runtime.consumeHydration({
      sessionId: SESSION_ID,
      hostGeneration: "7",
      attachmentEpoch: descriptor.attachmentEpoch,
      hydrationId: descriptor.hydrationId,
    });

    expect(hydration.descriptor).toMatchObject({
      mode: "delta",
      requestedAfterSeq: "1",
      firstOutputSeq: "2",
      lastOutputSeq: "2",
      gap: null,
    });
    expect(hydration.output.map((chunk) => Buffer.from(chunk.data).toString())).toEqual([
      "second",
    ]);
    await expect(runtime.sendCommand({
      sessionId: SESSION_ID,
      hostGeneration: "7",
      attachmentEpoch: descriptor.attachmentEpoch,
      commandSeq: "1",
      kind: "input",
      data: new Uint8Array([0x61]),
    })).rejects.toMatchObject({ code: "SESSION_NOT_RUNNING", retry: "REATTACH" });

    runtime.acknowledgeOutput({
      sessionId: SESSION_ID,
      hostGeneration: "7",
      attachmentEpoch: descriptor.attachmentEpoch,
      outputSeq: "2",
    });
    await expect(runtime.sendCommand({
      sessionId: SESSION_ID,
      hostGeneration: "7",
      attachmentEpoch: descriptor.attachmentEpoch,
      commandSeq: "1",
      kind: "input",
      data: new Uint8Array([0x61]),
    })).resolves.toBeUndefined();
  });

  it("prepares retained tail with an explicit gap after bounded eviction", async () => {
    const { host, runtime } = setup(65_536);
    await createRunningSession(runtime);
    host.emit({
      contractVersion: 1,
      kind: "output",
      sessionId: SESSION_ID,
      hostGeneration: "7",
      outputSeq: "1",
      dataBase64: Buffer.from(new Uint8Array(40_000).fill(1)).toString("base64"),
    });
    host.emit({
      contractVersion: 1,
      kind: "output",
      sessionId: SESSION_ID,
      hostGeneration: "7",
      outputSeq: "2",
      dataBase64: Buffer.from(new Uint8Array(40_000).fill(2)).toString("base64"),
    });

    const descriptor = await runtime.attach({
      sessionId: SESSION_ID,
      attachmentId: ATTACHMENT_ID,
      hostGeneration: "7",
      lastOutputSeq: "0",
      lastCommandSeq: "0",
      checkpointSeq: null,
    });
    const hydration = runtime.consumeHydration({
      sessionId: SESSION_ID,
      hostGeneration: "7",
      attachmentEpoch: descriptor.attachmentEpoch,
      hydrationId: descriptor.hydrationId,
    });

    expect(hydration.descriptor).toMatchObject({
      mode: "reset-tail-gap",
      firstOutputSeq: "2",
      lastOutputSeq: "2",
      gap: {
        firstMissingSeq: "1",
        lastMissingSeq: "1",
        retainedFromSeq: "2",
        retainedThroughSeq: "2",
        reason: "evicted",
      },
    });
    expect(hydration.output).toHaveLength(1);
    expect(hydration.output[0]?.data[0]).toBe(2);
  });

  it("fails the session visibly when host output is not contiguous", async () => {
    const { host, runtime } = setup();
    await createRunningSession(runtime);

    host.emit({
      contractVersion: 1,
      kind: "output",
      sessionId: SESSION_ID,
      hostGeneration: "7",
      outputSeq: "2",
      dataBase64: Buffer.from("missing-one").toString("base64"),
    });

    expect(runtime.getSnapshot(SESSION_ID)).toMatchObject({
      state: "failed",
      lastOutputSeq: "0",
      tombstone: true,
      exit: { reason: "protocol-failure" },
    });
  });

  it("restores a validated checkpoint only after renderer writes are acknowledged", async () => {
    const { host, runtime } = setup();
    await createRunningSession(runtime);
    const firstAttachment = await attach(runtime);
    host.emit({
      contractVersion: 1,
      kind: "output",
      sessionId: SESSION_ID,
      hostGeneration: "7",
      outputSeq: "1",
      dataBase64: Buffer.from("before-checkpoint").toString("base64"),
    });
    const checkpointData = Buffer.from("serialized-screen");
    const sha256 = createHash("sha256").update(checkpointData).digest("hex");

    await expect(runtime.saveCheckpoint({
      sessionId: SESSION_ID,
      hostGeneration: "7",
      attachmentEpoch: firstAttachment.attachmentEpoch,
      baseOutputSeq: "1",
      data: checkpointData,
      sha256,
    })).rejects.toMatchObject({ code: "CHECKPOINT_REJECTED" });
    runtime.acknowledgeOutput({
      sessionId: SESSION_ID,
      hostGeneration: "7",
      attachmentEpoch: firstAttachment.attachmentEpoch,
      outputSeq: "1",
    });
    await runtime.saveCheckpoint({
      sessionId: SESSION_ID,
      hostGeneration: "7",
      attachmentEpoch: firstAttachment.attachmentEpoch,
      baseOutputSeq: "1",
      data: checkpointData,
      sha256,
    });
    await runtime.detach({
      sessionId: SESSION_ID,
      attachmentId: ATTACHMENT_ID,
      attachmentEpoch: firstAttachment.attachmentEpoch,
      reason: "hide",
    });
    host.emit({
      contractVersion: 1,
      kind: "output",
      sessionId: SESSION_ID,
      hostGeneration: "7",
      outputSeq: "2",
      dataBase64: Buffer.from("after-checkpoint").toString("base64"),
    });

    const descriptor = await runtime.attach({
      sessionId: SESSION_ID,
      attachmentId: SECOND_ATTACHMENT_ID,
      hostGeneration: "7",
      lastOutputSeq: "0",
      lastCommandSeq: "0",
      checkpointSeq: "1",
    });
    const hydration = runtime.consumeHydration({
      sessionId: SESSION_ID,
      hostGeneration: "7",
      attachmentEpoch: descriptor.attachmentEpoch,
      hydrationId: descriptor.hydrationId,
    });

    expect(hydration.descriptor).toMatchObject({
      mode: "checkpoint-delta",
      checkpointThroughSeq: "1",
      firstOutputSeq: "2",
      lastOutputSeq: "2",
      gap: null,
    });
    expect(Buffer.from(hydration.checkpoint?.data ?? []).toString()).toBe("serialized-screen");
    expect(Buffer.from(hydration.output[0]?.data ?? []).toString()).toBe("after-checkpoint");
  });

  it("publishes a natural exit only after the renderer writes the final output", async () => {
    const { host, runtime } = setup();
    await createRunningSession(runtime);
    await attach(runtime);
    host.emit({
      contractVersion: 1,
      kind: "output",
      sessionId: SESSION_ID,
      hostGeneration: "7",
      outputSeq: "1",
      dataBase64: Buffer.from("final output").toString("base64"),
    });

    host.emit({
      contractVersion: 1,
      kind: "exit",
      sessionId: SESSION_ID,
      hostGeneration: "7",
      finalOutputSeq: "1",
      code: 0,
      signal: null,
      reason: "natural",
    });

    expect(runtime.getSnapshot(SESSION_ID)).toMatchObject({
      state: "exiting",
      lastOutputSeq: "1",
      exit: null,
      tombstone: false,
    });

    runtime.acknowledgeOutput({
      sessionId: SESSION_ID,
      hostGeneration: "7",
      attachmentEpoch: "1",
      outputSeq: "1",
    });

    expect(runtime.getSnapshot(SESSION_ID)).toMatchObject({
      state: "exited",
      lastOutputSeq: "1",
      exit: { code: 0, signal: null, reason: "natural" },
      tombstone: true,
    });
  });

  it("removes an exited tombstone when the user closes its Terminal tab", async () => {
    const { host, runtime } = setup();
    await createRunningSession(runtime);
    host.emit({
      contractVersion: 1,
      kind: "exit",
      sessionId: SESSION_ID,
      hostGeneration: "7",
      finalOutputSeq: "0",
      code: 0,
      signal: null,
      reason: "natural",
    });
    expect(runtime.getSnapshot(SESSION_ID)).toMatchObject({
      state: "exited",
      tombstone: true,
    });

    await expect(runtime.close({ sessionId: SESSION_ID, reason: "user" })).resolves.toMatchObject({
      state: "exited",
      tombstone: true,
    });

    expect(runtime.getSnapshot(SESSION_ID)).toBeNull();
    expect(host.closes).toHaveLength(0);
  });

  it("fails a natural exit when the final renderer write stalls", async () => {
    vi.useFakeTimers();
    const { host, runtime } = setup();
    await createRunningSession(runtime);
    await attach(runtime);
    host.emit({
      contractVersion: 1,
      kind: "output",
      sessionId: SESSION_ID,
      hostGeneration: "7",
      outputSeq: "1",
      dataBase64: Buffer.from("unacknowledged final output").toString("base64"),
    });
    host.emit({
      contractVersion: 1,
      kind: "exit",
      sessionId: SESSION_ID,
      hostGeneration: "7",
      finalOutputSeq: "1",
      code: 0,
      signal: null,
      reason: "natural",
    });

    await vi.advanceTimersByTimeAsync(2_000);

    expect(runtime.getSnapshot(SESSION_ID)).toMatchObject({
      state: "failed",
      exit: { code: null, signal: null, reason: "protocol-failure" },
      tombstone: true,
    });
  });

  it("finishes a natural exit headlessly when its Terminal tab closes", async () => {
    const { host, runtime } = setup();
    await createRunningSession(runtime);
    await attach(runtime);
    host.emit({
      contractVersion: 1,
      kind: "output",
      sessionId: SESSION_ID,
      hostGeneration: "7",
      outputSeq: "1",
      dataBase64: Buffer.from("final retained output").toString("base64"),
    });
    host.emit({
      contractVersion: 1,
      kind: "exit",
      sessionId: SESSION_ID,
      hostGeneration: "7",
      finalOutputSeq: "1",
      code: 0,
      signal: null,
      reason: "natural",
    });

    await expect(runtime.close({ sessionId: SESSION_ID, reason: "user" })).resolves.toMatchObject({
      state: "exited",
      lastOutputSeq: "1",
      exit: { code: 0, signal: null, reason: "natural" },
    });

    expect(runtime.getSnapshot(SESSION_ID)).toBeNull();
    expect(host.closes).toHaveLength(0);
  });

  it("fails live sessions without recreating them when their host crashes", async () => {
    const { host, runtime } = setup();
    await createRunningSession(runtime);
    host.emit({
      contractVersion: 1,
      kind: "output",
      sessionId: SESSION_ID,
      hostGeneration: "7",
      outputSeq: "1",
      dataBase64: Buffer.from("retained before crash").toString("base64"),
    });

    host.emit({
      contractVersion: 1,
      kind: "failure",
      hostGeneration: "7",
      boundary: "shutdown",
      recoverable: true,
      code: "HOST_UNHEALTHY",
    });

    expect(runtime.getSnapshot(SESSION_ID)).toMatchObject({
      state: "failed",
      lastOutputSeq: "1",
      exit: { code: null, signal: null, reason: "host-crash" },
      tombstone: true,
    });
    host.emit({
      contractVersion: 1,
      kind: "output",
      sessionId: SESSION_ID,
      hostGeneration: "7",
      outputSeq: "2",
      dataBase64: Buffer.from("late output from crashed host").toString("base64"),
    });
    expect(runtime.getSnapshot(SESSION_ID)?.lastOutputSeq).toBe("1");
    expect(host.creates).toHaveLength(1);
  });

  it("keeps a host-crash tombstone when the close barrier rejects", async () => {
    const { host, runtime } = setup();
    await createRunningSession(runtime);
    host.closeAction = () => {
      host.emit({
        contractVersion: 1,
        kind: "failure",
        hostGeneration: "7",
        boundary: "shutdown",
        recoverable: true,
        code: "HOST_UNHEALTHY",
      });
      throw new Error("PTY host process exited");
    };

    await expect(runtime.close({ sessionId: SESSION_ID, reason: "user" })).rejects.toMatchObject({
      code: "HOST_UNHEALTHY",
      retry: "SAFE_RETRY",
    });

    expect(runtime.getSnapshot(SESSION_ID)).toMatchObject({
      state: "failed",
      exit: { code: null, signal: null, reason: "host-crash" },
      tombstone: true,
    });
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
    expect(runtime.getSnapshot(SESSION_ID)).toBeNull();
    await expect(runtime.sendCommand({
      sessionId: SESSION_ID,
      hostGeneration: "7",
      attachmentEpoch: "1",
      commandSeq: "2",
      kind: "input",
      data: new Uint8Array([0x61]),
    })).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
  });
});
