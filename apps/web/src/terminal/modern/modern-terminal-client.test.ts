import { describe, expect, it, vi } from "vitest";
import {
  decodeTerminalFrame,
  encodeTerminalFrame,
  type TerminalBackendCapabilities,
} from "@mcode/contracts";
import { onPtyData } from "../legacy/pty-data-registry";
import { ModernTerminalClient } from "./modern-terminal-client";

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
    const unsubscribe = onPtyData(sessionId, (detail) => {
      received.push(`${detail.seq}:${new TextDecoder().decode(detail.payload)}`);
    });

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
    const unsubscribe = onPtyData(sessionId, (detail) => {
      received.push(`${detail.seq}:${new TextDecoder().decode(detail.payload)}`);
    });
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
});
