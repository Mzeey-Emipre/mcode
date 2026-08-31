import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  TERMINAL_CHECKPOINT_CHUNK_BYTES,
  WORKSPACE_ENVIRONMENT_ACTION_TRANSCRIPT_MAX_BYTES,
  TerminalDiagnosticsBundleSchema,
  decodeTerminalFrame,
  encodeTerminalFrame,
  type TerminalAttachmentDescriptor,
  type TerminalSessionSnapshot,
} from "@mcode/contracts";
import type { WebSocket } from "ws";
import type {
  PtyHostAdapter,
  PtyHostDiagnostics,
  PtyHostHealth,
} from "../../../host/pty-host-adapter.js";
import type {
  TerminalRuntimeDeliveryEvent,
  TerminalRuntimeHeadlessEvent,
  TerminalSessionRuntime,
} from "../../../sessions/terminal-session-runtime.js";
import type { TerminalHydration } from "../../../sessions/terminal-replay-buffer.js";
import {
  PreparedTerminalSessionLaunchError,
  type TerminalSessionService,
} from "../../../sessions/terminal-session-service.js";
import {
  PreparedTerminalCommandStartError,
  TerminalBackendError,
  type TerminalBackendSender,
} from "../../terminal-backend.js";
import { ModernTerminalBackend } from "../modern-terminal-backend.js";

const TEST_HOST_RUNTIME = { platform: "win32", architecture: "x64", nodeAbi: "127" } as const;

const sessionId = "00000000-0000-4000-8000-000000000001";
const attachmentId = "00000000-0000-4000-8000-000000000002";
const hydrationId = "00000000-0000-4000-8000-000000000003";
const hostGeneration = "7";

function makeDescriptor(): TerminalAttachmentDescriptor {
  return {
    contractVersion: 1,
    sessionId,
    attachmentId,
    attachmentEpoch: "1",
    hostGeneration,
    hydrationId,
    inputEnabled: false,
    serverHighBytes: 1_048_576,
    serverLowBytes: 262_144,
    clientHighBytes: 262_144,
    clientLowBytes: 65_536,
  };
}

function makeSnapshot(): TerminalSessionSnapshot {
  const scope = {
    kind: "workspace" as const,
    workspaceId: sessionId,
  };
  const profile = {
    id: "certified:windows-powershell-7" as const,
    name: "PowerShell 7",
    executable: "pwsh",
    arguments: [],
    source: "certified" as const,
    platform: "windows" as const,
  };
  return {
    contractVersion: 1,
    sessionId,
    scope,
    state: "running",
    hostGeneration,
    launch: {
      requestedProfileId: "automatic",
      resolvedProfile: profile,
      scope,
      arguments: [],
    },
    createdAt: "2026-08-12T10:00:00.000Z",
    lastCommandSeq: "0",
    lastOutputSeq: "1",
    exit: null,
    tombstone: false,
  };
}

function makeHarness() {
  const descriptor = makeDescriptor();
  const output = new TextEncoder().encode("abc");
  const hydration: TerminalHydration = {
    descriptor: {
      hydrationId,
      mode: "delta",
      requestedAfterSeq: "0",
      checkpointThroughSeq: null,
      firstOutputSeq: "1",
      lastOutputSeq: "1",
      gap: null,
      chunkCount: 1,
      totalBytes: output.byteLength,
    },
    checkpoint: null,
    output: [{ outputSeq: "1", data: output }],
  };
  const runtime = {
    attach: vi.fn(async () => descriptor),
    consumeHydration: vi.fn(() => hydration),
    sendCommand: vi.fn(async () => undefined),
    acknowledgeOutput: vi.fn(),
    saveCheckpoint: vi.fn(async () => undefined),
    detach: vi.fn(async () => undefined),
    close: vi.fn(async () => makeSnapshot()),
    getSnapshot: vi.fn((id: string) => id === sessionId ? makeSnapshot() : null),
    subscribeDelivery: vi.fn((listener: (event: TerminalRuntimeDeliveryEvent) => void) => {
      return () => { void listener; };
    }),
    shutdown: vi.fn(async () => undefined),
  } as unknown as TerminalSessionRuntime;
  const host: PtyHostAdapter & {
    health(): PtyHostHealth;
    diagnostics(): PtyHostDiagnostics;
  } = {
    start: vi.fn(async () => ({ hostGeneration, state: "healthy" as const })),
    health: vi.fn(() => ({ hostGeneration, state: "healthy" as const })),
    diagnostics: vi.fn(() => ({
      lastHeartbeatMsAgo: 10,
      queueBytes: 42,
      eventLoopLagMs: 3,
      hostRssBytes: "1024",
    })),
    create: vi.fn(),
    send: vi.fn(),
    inspectChildren: vi.fn(async () => ({ hasChildren: false })),
    close: vi.fn(),
    shutdown: vi.fn(async () => undefined),
    subscribe: vi.fn(() => () => undefined),
  };
  const sessions = {
    createSession: vi.fn(async () => makeSnapshot()),
    listSessions: vi.fn(() => [makeSnapshot()]),
    closeSession: vi.fn(async () => makeSnapshot()),
    dispose: vi.fn(),
  } as unknown as TerminalSessionService;
  const backend = new ModernTerminalBackend(sessions, runtime, host, () => 20);
  const frames: Uint8Array[] = [];
  const sender: TerminalBackendSender = {
    json: vi.fn(),
    data: vi.fn(),
    frame: (_client, bytes) => frames.push(Uint8Array.from(bytes)),
  };
  backend.setSender(sender);
  const client = {} as WebSocket;
  return { backend, runtime, client, frames, output };
}

describe("ModernTerminalBackend", () => {
  it("routes redacted diagnostics through the authenticated Terminal seam", async () => {
    const harness = makeHarness();
    const report = await harness.backend.routeV1("terminal.diagnostics.report", {
      events: [{
        eventId: "00000000-0000-4000-8000-000000000004",
        at: "2026-08-12T10:00:00.000Z",
        metric: "input.keydownToWrite.ms",
        unit: "ms",
        value: 12,
        outcome: "ok",
        correlationId: "secret-correlation",
      }],
    }, harness.client);
    expect(report).toEqual({ accepted: 1 });

    const bundle = TerminalDiagnosticsBundleSchema().parse(
      await harness.backend.routeV1("terminal.diagnostics.getBundle", {}, harness.client),
    );
    expect(bundle.events[0]?.correlationId).not.toBe("secret-correlation");
    expect(JSON.stringify(bundle)).not.toContain("secret-correlation");
    expect(bundle.health).toMatchObject({
      lastHeartbeatMsAgo: 10,
      queueBytes: 42,
      eventLoopLagMs: 3,
      hostRssBytes: "1024",
    });
  });

  it("keeps hydration directed and enforces attachment ownership for input", async () => {
    const harness = makeHarness();
    const descriptor = await harness.backend.routeV1("terminal.session.attach", {
      sessionId,
      attachmentId,
      hostGeneration,
      lastOutputSeq: "0",
      lastCommandSeq: "0",
    }, harness.client);

    expect(descriptor).toEqual(expect.objectContaining({ hydrationId }));
    expect(harness.frames.map((bytes) => decodeTerminalFrame(bytes).kind)).toEqual([
      "output",
      "hydrationComplete",
    ]);

    const input = encodeTerminalFrame({
      kind: "input",
      sessionId,
      attachmentId,
      hostGeneration,
      attachmentEpoch: "1",
      primarySeq: "1",
      relatedSeq: "0",
      payload: new TextEncoder().encode("echo hi\r"),
    });
    await harness.backend.handleV1Frame(harness.client, input);
    expect(harness.runtime.sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      sessionId,
      attachmentEpoch: "1",
      kind: "input",
    }));

    await expect(harness.backend.handleV1Frame({} as WebSocket, input)).rejects.toMatchObject({
      code: "STALE_ATTACHMENT",
    } satisfies Partial<TerminalBackendError>);
  });

  it("accepts only a complete contiguous checkpoint owned by the attachment", async () => {
    const harness = makeHarness();
    await harness.backend.routeV1("terminal.session.attach", {
      sessionId,
      attachmentId,
      hostGeneration,
      lastOutputSeq: "0",
      lastCommandSeq: "0",
    }, harness.client);
    const data = new TextEncoder().encode("checkpoint");
    const sha256 = createHash("sha256").update(data).digest("hex");
    const begun = await harness.backend.routeV1("terminal.session.checkpoint.begin", {
      sessionId,
      attachmentId,
      attachmentEpoch: "1",
      hostGeneration,
      baseOutputSeq: "1",
      declaredBytes: data.byteLength,
      sha256,
    }, harness.client) as { uploadId: string };
    expect(begun.uploadId).toMatch(/^[0-9a-f-]{36}$/);

    await harness.backend.handleV1Frame(harness.client, encodeTerminalFrame({
      kind: "checkpointChunk",
      sessionId,
      attachmentId,
      uploadId: begun.uploadId,
      hostGeneration,
      attachmentEpoch: "1",
      primarySeq: "0",
      relatedSeq: "1",
      payload: data,
    }));
    await expect(harness.backend.routeV1("terminal.session.checkpoint.complete", {
      sessionId,
      attachmentId,
      attachmentEpoch: "1",
      hostGeneration,
      uploadId: begun.uploadId,
      totalBytes: data.byteLength,
      sha256,
    }, harness.client)).resolves.toEqual({ accepted: true, checkpointThroughSeq: "1" });
    expect(harness.runtime.saveCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      baseOutputSeq: "1",
      sha256,
    }));
    expect(TERMINAL_CHECKPOINT_CHUNK_BYTES).toBe(65_536);
  });

  it("does not deliver runtime output to a different WebSocket", async () => {
    const harness = makeHarness();
    await harness.backend.routeV1("terminal.session.attach", {
      sessionId,
      attachmentId,
      hostGeneration,
      lastOutputSeq: "0",
      lastCommandSeq: "0",
    }, harness.client);
    const initialCount = harness.frames.length;
    harness.backend.disconnectClient({} as WebSocket);
    expect(harness.frames).toHaveLength(initialCount);
  });

  it("coalesces multiple retained output chunks under the hydration byte bound", async () => {
    const harness = makeHarness();
    const runtime = harness.runtime as unknown as { consumeHydration: ReturnType<typeof vi.fn> };
    runtime.consumeHydration.mockReturnValue({
      descriptor: {
        hydrationId,
        mode: "delta",
        requestedAfterSeq: "0",
        checkpointThroughSeq: null,
        firstOutputSeq: "1",
        lastOutputSeq: "2",
        gap: null,
        chunkCount: 1,
        totalBytes: 5,
      },
      checkpoint: null,
      output: [
        { outputSeq: "1", data: new TextEncoder().encode("ab") },
        { outputSeq: "2", data: new TextEncoder().encode("cde") },
      ],
    });

    await harness.backend.routeV1("terminal.session.attach", {
      sessionId,
      attachmentId,
      hostGeneration,
      lastOutputSeq: "0",
      lastCommandSeq: "0",
    }, harness.client);

    const outputFrames = harness.frames
      .map((bytes) => decodeTerminalFrame(bytes))
      .filter((frame) => frame.kind === "output");
    expect(outputFrames).toHaveLength(1);
    expect(outputFrames[0]).toEqual(expect.objectContaining({ primarySeq: "2", payload: new TextEncoder().encode("abcde") }));
    const complete = decodeTerminalFrame(harness.frames.at(-1)!);
    expect(complete.kind).toBe("hydrationComplete");
    expect(JSON.parse(new TextDecoder().decode(complete.payload))).toEqual(expect.objectContaining({ chunkCount: 1 }));

    await harness.backend.handleV1Frame(harness.client, encodeTerminalFrame({
      kind: "outputAck",
      sessionId,
      attachmentId,
      hostGeneration,
      attachmentEpoch: "1",
      primarySeq: "2",
      relatedSeq: "0",
      payload: new Uint8Array(),
    }));
    expect(harness.runtime.acknowledgeOutput).toHaveBeenCalledWith(expect.objectContaining({ outputSeq: "2" }));
  });

  it("queues output emitted between runtime attach and route finalization", async () => {
    const harness = makeHarness();
    const runtime = harness.runtime as unknown as {
      attach: ReturnType<typeof vi.fn>;
      subscribeDelivery: ReturnType<typeof vi.fn>;
    };
    const listener = runtime.subscribeDelivery.mock.calls[0]?.[0] as (event: TerminalRuntimeDeliveryEvent) => void;
    runtime.attach.mockImplementation(async () => {
      listener({
        kind: "output",
        sessionId,
        hostGeneration,
        attachmentEpoch: "1",
        outputSeq: "2",
        data: new TextEncoder().encode("race"),
      });
      return makeDescriptor();
    });

    await harness.backend.routeV1("terminal.session.attach", {
      sessionId,
      attachmentId,
      hostGeneration,
      lastOutputSeq: "0",
      lastCommandSeq: "0",
    }, harness.client);

    const frames = harness.frames.map((bytes) => decodeTerminalFrame(bytes));
    expect(frames.map((frame) => frame.kind)).toEqual(["output", "hydrationComplete", "output"]);
    expect(new TextDecoder().decode(frames[0]!.payload)).toBe("abc");
    expect(new TextDecoder().decode(frames[2]!.payload)).toBe("race");
  });

  it("publishes live output and command acknowledgements to the attached client", async () => {
    const harness = makeHarness();
    await harness.backend.routeV1("terminal.session.attach", {
      sessionId,
      attachmentId,
      hostGeneration,
      lastOutputSeq: "0",
      lastCommandSeq: "0",
    }, harness.client);
    const runtime = harness.runtime as unknown as { subscribeDelivery: ReturnType<typeof vi.fn> };
    const listener = runtime.subscribeDelivery.mock.calls[0]?.[0] as ((event: TerminalRuntimeDeliveryEvent) => void);
    listener({
      kind: "commandAck",
      sessionId,
      hostGeneration,
      attachmentEpoch: "1",
      commandSeq: "1",
      outputSeq: "1",
    });
    listener({
      kind: "output",
      sessionId,
      hostGeneration,
      attachmentEpoch: "1",
      outputSeq: "1",
      data: new TextEncoder().encode("out"),
    });
    expect(harness.frames.slice(-2).map((bytes) => decodeTerminalFrame(bytes).kind)).toEqual(["commandAck", "output"]);
  });

  it("revokes the attachment and checkpoint uploads after a successful close", async () => {
    const harness = makeHarness();
    await harness.backend.routeV1("terminal.session.attach", {
      sessionId,
      attachmentId,
      hostGeneration,
      lastOutputSeq: "0",
      lastCommandSeq: "0",
    }, harness.client);
    const data = new TextEncoder().encode("checkpoint");
    const sha256 = createHash("sha256").update(data).digest("hex");
    const begun = await harness.backend.routeV1("terminal.session.checkpoint.begin", {
      sessionId,
      attachmentId,
      attachmentEpoch: "1",
      hostGeneration,
      baseOutputSeq: "1",
      declaredBytes: data.byteLength,
      sha256,
    }, harness.client) as { uploadId: string };

    await harness.backend.routeV1("terminal.session.close", {
      sessionId,
      reason: "user",
    }, harness.client);

    const input = encodeTerminalFrame({
      kind: "input",
      sessionId,
      attachmentId,
      hostGeneration,
      attachmentEpoch: "1",
      primarySeq: "1",
      relatedSeq: "0",
      payload: new TextEncoder().encode("echo hi\r"),
    });
    await expect(harness.backend.handleV1Frame(harness.client, input)).rejects.toMatchObject({
      code: "STALE_ATTACHMENT",
    });
    await expect(harness.backend.routeV1("terminal.session.checkpoint.complete", {
      sessionId,
      attachmentId,
      attachmentEpoch: "1",
      hostGeneration,
      uploadId: begun.uploadId,
      totalBytes: data.byteLength,
      sha256,
    }, harness.client)).rejects.toMatchObject({ code: "CHECKPOINT_REJECTED" });
  });

  it("replays a fast prepared Action exit and retains the exact launch facts", async () => {
    let publishHeadless: ((event: TerminalRuntimeHeadlessEvent) => void) | undefined;
    const runtime = {
      subscribeDelivery: vi.fn(() => () => undefined),
      subscribeHeadless: vi.fn((listener: (event: TerminalRuntimeHeadlessEvent) => void) => {
        publishHeadless = listener;
        return () => undefined;
      }),
      readHeadlessReplay: vi.fn(() => ({
        output: [new TextEncoder().encode("fast output")],
        exitCode: 0,
      })),
    } as unknown as TerminalSessionRuntime;
    const snapshot = {
      ...makeSnapshot(),
      scope: { kind: "thread" as const, workspaceId: "workspace-1", threadId: "thread-1" },
      launch: {
        ...makeSnapshot().launch,
        resolvedProfile: { ...makeSnapshot().launch.resolvedProfile, executable: "pwsh" },
        arguments: ["-NoProfile", "-Command", "Write-Output fast"],
      },
    };
    const releasePreparedSession = vi.fn();
    const sessions = {
      createPreparedSession: vi.fn(async () => ({
        session: snapshot,
        checkoutPath: "C:/repo/.worktrees/thread-1",
        environmentNames: ["HOME", "PATH"],
      })),
      releasePreparedSession,
      closeSession: vi.fn(async () => snapshot),
      dispose: vi.fn(),
    } as unknown as TerminalSessionService;
    const host = {
      start: vi.fn(async () => ({ hostGeneration, state: "healthy" as const })),
      health: vi.fn(() => ({ hostGeneration, state: "healthy" as const })),
      diagnostics: vi.fn(() => ({ lastHeartbeatMsAgo: 0, queueBytes: 0, eventLoopLagMs: 0, hostRssBytes: "0" })),
    } as unknown as PtyHostAdapter & { health(): PtyHostHealth; diagnostics(): PtyHostDiagnostics };
    const backend = new ModernTerminalBackend(sessions, runtime, host, () => 20, undefined, () => "workspace-1");

    const prepared = await backend.startPreparedCommand({ threadId: "thread-1", script: "Write-Output fast" });
    const output = vi.fn();
    const exit = vi.fn();
    prepared.onOutput(output);
    prepared.onExit(exit);
    publishHeadless?.({ kind: "exit", sessionId, exitCode: 0 });

    expect(new TextDecoder().decode(output.mock.calls[0]?.[0])).toBe("fast output");
    expect(output).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(releasePreparedSession).toHaveBeenCalledOnce();
    await expect(prepared.stop()).resolves.toBeUndefined();
    expect(sessions.closeSession).not.toHaveBeenCalled();
    expect(prepared.snapshot).toMatchObject({
      checkoutPath: "C:/repo/.worktrees/thread-1",
      environmentNames: ["HOME", "PATH"],
      terminal: { executable: "pwsh", arguments: ["-NoProfile", "-Command", "Write-Output fast"] },
    });
  });

  it.each(["live", "late"] as const)(
    "releases a prepared Action from a nullable host-crash exit delivered %s",
    async (delivery) => {
      let publishHeadless: ((event: TerminalRuntimeHeadlessEvent) => void) | undefined;
      const runtime = {
        subscribeDelivery: vi.fn(() => () => undefined),
        subscribeHeadless: vi.fn((listener: (event: TerminalRuntimeHeadlessEvent) => void) => {
          publishHeadless = listener;
          return () => undefined;
        }),
        readHeadlessReplay: vi.fn(() => ({
          output: [],
          exitCode: delivery === "late" ? null : undefined,
        })),
      } as unknown as TerminalSessionRuntime;
      const snapshot = {
        ...makeSnapshot(),
        scope: { kind: "thread" as const, workspaceId: "workspace-1", threadId: "thread-1" },
      };
      const releasePreparedSession = vi.fn();
      const sessions = {
        createPreparedSession: vi.fn(async () => ({
          session: snapshot,
          checkoutPath: "C:/repo/.worktrees/thread-1",
          environmentNames: ["PATH"],
        })),
        releasePreparedSession,
        closeSession: vi.fn(async () => snapshot),
        dispose: vi.fn(),
      } as unknown as TerminalSessionService;
      const host = {
        start: vi.fn(async () => ({ hostGeneration, state: "healthy" as const })),
        health: vi.fn(() => ({ hostGeneration, state: "healthy" as const })),
        diagnostics: vi.fn(() => ({ lastHeartbeatMsAgo: 0, queueBytes: 0, eventLoopLagMs: 0, hostRssBytes: "0" })),
      } as unknown as PtyHostAdapter & { health(): PtyHostHealth; diagnostics(): PtyHostDiagnostics };
      const backend = new ModernTerminalBackend(sessions, runtime, host, () => 20, undefined, () => "workspace-1");

      const prepared = await backend.startPreparedCommand({ threadId: "thread-1", script: "Write-Output crash" });
      const exit = vi.fn();
      prepared.onExit(exit);
      if (delivery === "live") {
        publishHeadless?.({ kind: "exit", sessionId, exitCode: null });
        publishHeadless?.({ kind: "exit", sessionId, exitCode: null });
      }

      expect(exit).toHaveBeenCalledExactlyOnceWith({ exitCode: null });
      expect(releasePreparedSession).toHaveBeenCalledOnce();
    },
  );

  it("bounds noisy prepared output received before its Action owner attaches", async () => {
    let publishHeadless: ((event: TerminalRuntimeHeadlessEvent) => void) | undefined;
    const runtime = {
      subscribeDelivery: vi.fn(() => () => undefined),
      subscribeHeadless: vi.fn((listener: (event: TerminalRuntimeHeadlessEvent) => void) => {
        publishHeadless = listener;
        return () => undefined;
      }),
      readHeadlessReplay: vi.fn(() => ({ output: [], exitCode: undefined })),
    } as unknown as TerminalSessionRuntime;
    const snapshot = {
      ...makeSnapshot(),
      scope: { kind: "thread" as const, workspaceId: "workspace-1", threadId: "thread-1" },
    };
    const sessions = {
      createPreparedSession: vi.fn(async () => ({
        session: snapshot,
        checkoutPath: "C:/repo/.worktrees/thread-1",
        environmentNames: ["PATH"],
      })),
      releasePreparedSession: vi.fn(),
      closeSession: vi.fn(async () => snapshot),
      dispose: vi.fn(),
    } as unknown as TerminalSessionService;
    const host = {
      start: vi.fn(async () => ({ hostGeneration, state: "healthy" as const })),
      health: vi.fn(() => ({ hostGeneration, state: "healthy" as const })),
      diagnostics: vi.fn(() => ({ lastHeartbeatMsAgo: 0, queueBytes: 0, eventLoopLagMs: 0, hostRssBytes: "0" })),
    } as unknown as PtyHostAdapter & { health(): PtyHostHealth; diagnostics(): PtyHostDiagnostics };
    const backend = new ModernTerminalBackend(sessions, runtime, host, () => 20, undefined, () => "workspace-1");

    const prepared = await backend.startPreparedCommand({ threadId: "thread-1", script: "Write-Output noisy" });
    publishHeadless?.({
      kind: "output",
      sessionId,
      data: new Uint8Array(WORKSPACE_ENVIRONMENT_ACTION_TRANSCRIPT_MAX_BYTES).fill(65),
    });
    publishHeadless?.({ kind: "output", sessionId, data: Uint8Array.of(90) });
    const output = vi.fn();
    prepared.onOutput(output);
    const retained = Buffer.concat(output.mock.calls.map(([data]) => Buffer.from(data)));

    expect(retained).toHaveLength(WORKSPACE_ENVIRONMENT_ACTION_TRANSCRIPT_MAX_BYTES);
    expect(retained[0]).toBe(65);
    expect(retained.at(-1)).toBe(90);
  });

  it("preserves resolved launch metadata in a failed Action start without a terminal identity", async () => {
    const runtime = {
      subscribeDelivery: vi.fn(() => () => undefined),
    } as unknown as TerminalSessionRuntime;
    const plan = {
      checkoutPath: "C:/repo/.worktrees/thread-1",
      terminal: { executable: "pwsh", arguments: ["-NoProfile", "-Command", "Write-Output failed"] },
      environmentNames: ["PATH"],
    };
    const sessions = {
      createPreparedSession: vi.fn(async () => {
        throw new PreparedTerminalSessionLaunchError(plan, new Error("host unavailable"));
      }),
      dispose: vi.fn(),
    } as unknown as TerminalSessionService;
    const host = {
      start: vi.fn(async () => ({ hostGeneration, state: "healthy" as const })),
      health: vi.fn(() => ({ hostGeneration, state: "healthy" as const })),
      diagnostics: vi.fn(() => ({ lastHeartbeatMsAgo: 0, queueBytes: 0, eventLoopLagMs: 0, hostRssBytes: "0" })),
    } as unknown as PtyHostAdapter & { health(): PtyHostHealth; diagnostics(): PtyHostDiagnostics };
    const backend = new ModernTerminalBackend(sessions, runtime, host, () => 20, undefined, () => "workspace-1");

    const failure = await backend.startPreparedCommand({
      threadId: "thread-1",
      script: "Write-Output failed",
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PreparedTerminalCommandStartError);
    expect(failure).toMatchObject({
      snapshot: {
        script: "Write-Output failed",
        checkoutPath: plan.checkoutPath,
        terminal: plan.terminal,
        environmentNames: plan.environmentNames,
      },
    });
  });
});
