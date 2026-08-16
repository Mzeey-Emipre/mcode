import { describe, expect, it, vi } from "vitest";
import {
  decodeTerminalFrame,
  encodeTerminalFrame,
  type TerminalBackendCapabilities,
} from "@mcode/contracts";
import { ModernTerminalClient } from "../modern/modern-terminal-client";

const sessionId = "00000000-0000-4000-8000-000000000001";
const hydrationId = "00000000-0000-4000-8000-000000000002";
const hostGeneration = "7";

const capabilities: Extract<TerminalBackendCapabilities, { contractVersion: 1 }> = {
  contractVersion: 1,
  backend: "modern",
  selectedAt: "2026-08-12T10:00:00.000Z",
  publicFrameVersion: 1,
  recovery: { replay: true, checkpoint: true, gap: true },
  host: { state: "healthy", generation: hostGeneration },
  sessionLimit: 20,
};

describe("ModernTerminalClient", () => {
  it("holds live output until hydration completes and acknowledges written output", async () => {
    let attachmentId = "";
    const sendFrame = vi.fn<(frame: Uint8Array) => void>();
    const rpc = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "terminal.session.attach") {
        attachmentId = String(params.attachmentId);
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
      throw new Error(`Unexpected RPC: ${method}`);
    });
    const client = new ModernTerminalClient(
      rpc as never,
      sendFrame,
      capabilities,
      async () => ({ kind: "workspace", workspaceId: sessionId }),
    );
    const received: string[] = [];
    const unsubscribe = client.subscribe(sessionId, { onData: (detail) => {
      received.push(`${detail.seq}:${new TextDecoder().decode(detail.payload)}`);
    }});

    await client.reattach(sessionId, -1);
    const output = new TextEncoder().encode("abc");
    client.handleFrame(encodeTerminalFrame({
      kind: "output",
      sessionId,
      attachmentId,
      hydrationId,
      hostGeneration,
      attachmentEpoch: "1",
      primarySeq: "1",
      relatedSeq: "0",
      payload: output,
    }));
    expect(received).toEqual([]);

    client.handleFrame(encodeTerminalFrame({
      kind: "hydrationComplete",
      sessionId,
      attachmentId,
      hydrationId,
      hostGeneration,
      attachmentEpoch: "1",
      primarySeq: "1",
      relatedSeq: "0",
      payload: new TextEncoder().encode(JSON.stringify({
        hydrationId,
        mode: "delta",
        requestedAfterSeq: "0",
        checkpointThroughSeq: null,
        firstOutputSeq: "1",
        lastOutputSeq: "1",
        gap: null,
        chunkCount: 1,
        totalBytes: 3,
      })),
    }));
    client.handleFrame(encodeTerminalFrame({
      kind: "output",
      sessionId,
      attachmentId,
      hostGeneration,
      attachmentEpoch: "1",
      primarySeq: "2",
      relatedSeq: "0",
      payload: new TextEncoder().encode("tail"),
    }));
    expect(received).toEqual(["1:abc", "2:tail"]);

    client.acknowledgeOutput(sessionId, 2);
    expect(decodeTerminalFrame(sendFrame.mock.calls[0]![0])).toMatchObject({
      kind: "outputAck",
      sessionId,
      attachmentEpoch: "1",
      primarySeq: "2",
    });
    unsubscribe();
  });

  it("returns checkpoint mode only after checkpoint hydration completes", async () => {
    let attachmentId = "";
    const rpc = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "terminal.session.attach") {
        attachmentId = String(params.attachmentId);
        return { attachmentId, attachmentEpoch: "1", hydrationId };
      }
      throw new Error(`Unexpected RPC: ${method}`);
    });
    const client = new ModernTerminalClient(
      rpc as never,
      vi.fn(),
      capabilities,
      async () => ({ kind: "workspace", workspaceId: sessionId }),
    );
    const received: string[] = [];
    const unsubscribe = client.subscribe(sessionId, { onData: (detail) => {
      received.push(`${detail.seq}:${new TextDecoder().decode(detail.payload)}`);
    }});
    const reattach = client.reattach(sessionId, -1);
    const checkpoint = new TextEncoder().encode("checkpoint");
    client.handleFrame(encodeTerminalFrame({
      kind: "hydrationChunk",
      sessionId,
      attachmentId,
      hydrationId,
      hostGeneration,
      attachmentEpoch: "1",
      primarySeq: "0",
      relatedSeq: "1",
      payload: checkpoint,
    }));
    const tail = new TextEncoder().encode("tail");
    client.handleFrame(encodeTerminalFrame({
      kind: "output",
      sessionId,
      attachmentId,
      hydrationId,
      hostGeneration,
      attachmentEpoch: "1",
      primarySeq: "3",
      relatedSeq: "0",
      payload: tail,
    }));
    client.handleFrame(encodeTerminalFrame({
      kind: "hydrationComplete",
      sessionId,
      attachmentId,
      hydrationId,
      hostGeneration,
      attachmentEpoch: "1",
      primarySeq: "3",
      relatedSeq: "0",
      payload: new TextEncoder().encode(JSON.stringify({
        hydrationId,
        mode: "checkpoint-delta",
        requestedAfterSeq: "0",
        checkpointThroughSeq: "2",
        firstOutputSeq: "3",
        lastOutputSeq: "3",
        gap: null,
        chunkCount: 2,
        totalBytes: checkpoint.byteLength + tail.byteLength,
      })),
    }));
    await expect(reattach).resolves.toEqual({
      mode: "checkpoint",
      checkpoint: "checkpoint",
      checkpointThrough: 2,
    });
    expect(received).toEqual(["3:tail"]);
    unsubscribe();
  });

  it("retains an accepted checkpoint through detach and clears it after reset hydration", async () => {
    const attachCalls: Record<string, unknown>[] = [];
    let attachmentId = "";
    let attachCount = 0;
    let resolveResetAttach: ((value: { attachmentId: string; attachmentEpoch: string; hydrationId: string }) => void) | undefined;
    const rpc = vi.fn((method: string, params: Record<string, unknown>) => {
      if (method === "terminal.session.attach") {
        attachCalls.push(params);
        attachmentId = String(params.attachmentId);
        attachCount += 1;
        if (attachCount === 2) {
          return new Promise<{ attachmentId: string; attachmentEpoch: string; hydrationId: string }>((resolve) => {
            resolveResetAttach = resolve;
          });
        }
        return { attachmentId, attachmentEpoch: String(attachCount), hydrationId };
      }
      if (method === "terminal.session.checkpoint.begin") return { uploadId: "00000000-0000-4000-8000-000000000004" };
      if (method === "terminal.session.checkpoint.complete") return { accepted: true, checkpointThroughSeq: "2" };
      return undefined;
    });
    const client = new ModernTerminalClient(
      rpc as never,
      vi.fn(),
      capabilities,
      async () => ({ kind: "workspace", workspaceId: sessionId }),
    );
    const completeDelta = () => client.handleFrame(encodeTerminalFrame({
      kind: "hydrationComplete",
      sessionId,
      attachmentId,
      hydrationId,
      hostGeneration,
      attachmentEpoch: String(attachCount),
      primarySeq: "0",
      relatedSeq: "0",
      payload: new TextEncoder().encode(JSON.stringify({
        hydrationId,
        mode: "delta",
        requestedAfterSeq: "0",
        checkpointThroughSeq: null,
        firstOutputSeq: null,
        lastOutputSeq: null,
        gap: null,
        chunkCount: 0,
        totalBytes: 0,
      })),
    }));

    const firstAttach = client.reattach(sessionId, 0);
    await Promise.resolve();
    completeDelta();
    await firstAttach;
    await client.checkpoint(sessionId, 2, "checkpoint");
    await client.pause(sessionId);

    const resetAttach = client.reattach(sessionId, 0);
    client.handleFrame(encodeTerminalFrame({
      kind: "hydrationComplete",
      sessionId,
      attachmentId,
      hydrationId,
      hostGeneration,
      attachmentEpoch: "2",
      primarySeq: "1",
      relatedSeq: "0",
      payload: new TextEncoder().encode(JSON.stringify({
        hydrationId,
        mode: "reset-tail-gap",
        requestedAfterSeq: "0",
        checkpointThroughSeq: null,
        firstOutputSeq: "1",
        lastOutputSeq: "1",
        gap: {
          kind: "replay",
          firstMissingSeq: "1",
          lastMissingSeq: "1",
          retainedFromSeq: "2",
          retainedThroughSeq: "2",
          reason: "evicted",
        },
        chunkCount: 0,
        totalBytes: 0,
      })),
    }));
    resolveResetAttach?.({ attachmentId, attachmentEpoch: "2", hydrationId });
    await expect(resetAttach).resolves.toEqual({ mode: "reset", discardThrough: 1 });
    await client.pause(sessionId);

    const thirdAttach = client.reattach(sessionId, 1);
    await Promise.resolve();
    completeDelta();
    await thirdAttach;
    expect(attachCalls[1]).toHaveProperty("checkpointSeq", "2");
    expect(attachCalls[2]).not.toHaveProperty("checkpointSeq");
  });

  it("detaches the captured attachment when a replacement reattaches before checkpoint completion", async () => {
    const attachCalls: Record<string, unknown>[] = [];
    const detachCalls: Record<string, unknown>[] = [];
    let attachCount = 0;
    let releaseCheckpoint: (() => void) | undefined;
    const rpc = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "terminal.session.attach") {
        attachCalls.push(params);
        attachCount += 1;
        return {
          attachmentId: params.attachmentId,
          attachmentEpoch: String(attachCount),
          hydrationId: crypto.randomUUID(),
        };
      }
      if (method === "terminal.session.checkpoint.begin") return { uploadId: crypto.randomUUID() };
      if (method === "terminal.session.checkpoint.complete") {
        return { accepted: true, checkpointThroughSeq: String(params.baseOutputSeq ?? "0") };
      }
      if (method === "terminal.session.detach") {
        detachCalls.push(params);
        return { detached: true };
      }
      throw new Error(`Unexpected RPC: ${method}`);
    });
    const client = new ModernTerminalClient(
      rpc as never,
      vi.fn(),
      capabilities,
      async () => ({ kind: "workspace", workspaceId: sessionId }),
    );
    await client.reattach(sessionId, 0);
    const checkpoint = new Promise<{ seq: number; data: string }>((resolve) => {
      releaseCheckpoint = () => resolve({ seq: 4, data: "screen" });
    });
    const oldRelease = client.detachForSwitch(sessionId, checkpoint);
    await client.reattach(sessionId, 0);
    releaseCheckpoint?.();
    await oldRelease;

    expect(attachCalls).toHaveLength(2);
    expect(detachCalls).toHaveLength(1);
    expect(detachCalls[0]).toMatchObject({
      attachmentId: attachCalls[0]?.attachmentId,
      attachmentEpoch: "1",
    });
    expect(detachCalls[0]?.attachmentId).not.toBe(attachCalls[1]?.attachmentId);
  });

  it("retains exited and failed tombstones in the reconnect projection", async () => {
    const rpc = vi.fn(async (method: string) => {
      if (method !== "terminal.session.list") throw new Error(`Unexpected RPC: ${method}`);
      return [
        { sessionId: "pty-running", state: "running", scope: { kind: "workspace", workspaceId: sessionId } },
        { sessionId: "pty-exited", state: "exited", scope: { kind: "workspace", workspaceId: sessionId } },
        { sessionId: "pty-failed", state: "failed", scope: { kind: "thread", workspaceId: sessionId, threadId: sessionId } },
      ];
    });
    const client = new ModernTerminalClient(
      rpc as never,
      vi.fn(),
      capabilities,
      async () => ({ kind: "workspace", workspaceId: sessionId }),
    );

    await expect(client.listActive()).resolves.toEqual([
      { ptyId: "pty-running", threadId: sessionId, state: "running" },
      { ptyId: "pty-exited", threadId: sessionId, state: "exited" },
      { ptyId: "pty-failed", threadId: sessionId, state: "failed" },
    ]);
  });

  it("delivers structured replay gaps and exit metadata for the current attachment", async () => {
    let attachmentId = "";
    const rpc = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method !== "terminal.session.attach") throw new Error(`Unexpected RPC: ${method}`);
      attachmentId = String(params.attachmentId);
      return { attachmentId, attachmentEpoch: "1", hydrationId };
    });
    const client = new ModernTerminalClient(
      rpc as never,
      vi.fn(),
      capabilities,
      async () => ({ kind: "workspace", workspaceId: sessionId }),
    );
    const gaps: unknown[] = [];
    const exits: unknown[] = [];
    client.subscribe(sessionId, {
      onReconnectGap: (gap) => gaps.push(gap),
      onExit: (exit) => exits.push(exit),
    });

    const reattach = client.reattach(sessionId, -1);
    const hydration = {
      hydrationId,
      mode: "delta",
      requestedAfterSeq: "0",
      checkpointThroughSeq: null,
      firstOutputSeq: null,
      lastOutputSeq: null,
      gap: null,
      chunkCount: 0,
      totalBytes: 0,
    };
    client.handleFrame(encodeTerminalFrame({
      kind: "hydrationComplete",
      sessionId,
      attachmentId,
      hydrationId,
      hostGeneration,
      attachmentEpoch: "1",
      primarySeq: "0",
      relatedSeq: "0",
      payload: new TextEncoder().encode(JSON.stringify(hydration)),
    }));
    await reattach;

    const gap = {
      kind: "replay",
      firstMissingSeq: "1",
      lastMissingSeq: "1",
      retainedFromSeq: "2",
      retainedThroughSeq: "2",
      reason: "evicted",
    } as const;
    client.handleFrame(encodeTerminalFrame({
      kind: "gap",
      sessionId,
      attachmentId,
      hydrationId,
      hostGeneration,
      attachmentEpoch: "1",
      primarySeq: "1",
      relatedSeq: "1",
      payload: new TextEncoder().encode(JSON.stringify(gap)),
    }));
    client.handleFrame(encodeTerminalFrame({
      kind: "exitBarrier",
      sessionId,
      attachmentId,
      hostGeneration,
      attachmentEpoch: "1",
      primarySeq: "1",
      relatedSeq: "1",
      payload: new TextEncoder().encode(JSON.stringify({
        finalOutputSeq: "1",
        exit: { code: 7, signal: null, reason: "natural" },
      })),
    }));

    expect(gaps).toEqual([gap]);
    expect(exits).toEqual([expect.objectContaining({
      ptyId: sessionId,
      code: 7,
      state: "exited",
      exit: { code: 7, signal: null, reason: "natural" },
    })]);
  });

  it("rejects stale output, gap, and exit frames after a new attachment epoch", async () => {
    let attachmentId = "";
    const received: string[] = [];
    const gaps: string[] = [];
    const exits: number[] = [];
    const rpc = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method !== "terminal.session.attach") throw new Error(`Unexpected RPC: ${method}`);
      attachmentId = String(params.attachmentId);
      return { attachmentId, attachmentEpoch: "1", hydrationId };
    });
    const client = new ModernTerminalClient(
      rpc as never,
      vi.fn(),
      capabilities,
      async () => ({ kind: "workspace", workspaceId: sessionId }),
    );
    client.subscribe(sessionId, {
      onData: (event) => received.push(new TextDecoder().decode(event.payload)),
      onReconnectGap: () => gaps.push("gap"),
      onExit: (event) => exits.push(event.code),
    });

    const reattach = client.reattach(sessionId, -1);
    client.handleFrame(encodeTerminalFrame({
      kind: "hydrationComplete",
      sessionId,
      attachmentId,
      hydrationId,
      hostGeneration,
      attachmentEpoch: "1",
      primarySeq: "0",
      relatedSeq: "0",
      payload: new TextEncoder().encode(JSON.stringify({
        hydrationId,
        mode: "delta",
        requestedAfterSeq: "0",
        checkpointThroughSeq: null,
        firstOutputSeq: null,
        lastOutputSeq: null,
        gap: null,
        chunkCount: 0,
        totalBytes: 0,
      })),
    }));
    await reattach;

    client.handleFrame(encodeTerminalFrame({
      kind: "output",
      sessionId,
      attachmentId,
      hostGeneration,
      attachmentEpoch: "2",
      primarySeq: "1",
      relatedSeq: "0",
      payload: new TextEncoder().encode("stale"),
    }));
    const gap = {
      kind: "replay",
      firstMissingSeq: "1",
      lastMissingSeq: "1",
      retainedFromSeq: "2",
      retainedThroughSeq: "2",
      reason: "evicted",
    };
    client.handleFrame(encodeTerminalFrame({
      kind: "gap",
      sessionId,
      attachmentId,
      hydrationId,
      hostGeneration,
      attachmentEpoch: "2",
      primarySeq: "1",
      relatedSeq: "1",
      payload: new TextEncoder().encode(JSON.stringify(gap)),
    }));
    client.handleFrame(encodeTerminalFrame({
      kind: "exitBarrier",
      sessionId,
      attachmentId,
      hostGeneration,
      attachmentEpoch: "2",
      primarySeq: "1",
      relatedSeq: "1",
      payload: new TextEncoder().encode(JSON.stringify({
        finalOutputSeq: "1",
        exit: { code: 7, signal: null, reason: "natural" },
      })),
    }));

    expect(received).toEqual([]);
    expect(gaps).toEqual([]);
    expect(exits).toEqual([]);
  });
});
