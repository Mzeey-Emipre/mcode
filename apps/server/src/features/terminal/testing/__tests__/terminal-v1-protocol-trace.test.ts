import { describe, expect, it } from "vitest";
import {
  executeTerminalTransitionTrace,
  TERMINAL_BOOT_TRANSITIONS,
  TERMINAL_SESSION_TRANSITIONS,
  type TerminalBinaryFrame,
} from "@mcode/contracts";
import { executeTerminalV1ProtocolTrace } from "../terminal-v1-protocol-trace.js";

const SESSION = "abcdef12-abcd-4abc-8abc-abcdefabcdef";
const ATTACHMENT = "12345678-abcd-4abc-8abc-abcdefabcdef";
const encoder = new TextEncoder();

const outputFrame = {
  kind: "output",
  sessionId: SESSION,
  attachmentId: ATTACHMENT,
  hostGeneration: "7",
  attachmentEpoch: "1",
  primarySeq: "1",
  relatedSeq: "0",
  payload: encoder.encode("ready\r\n"),
} satisfies TerminalBinaryFrame;

describe("Terminal v1 executable protocol traces", () => {
  it("executes create, output, natural exit, and tombstone release across both codecs", () => {
    const result = executeTerminalV1ProtocolTrace("7", [
      {
        channel: "server-to-host",
        value: {
          contractVersion: 1,
          kind: "handshake",
          requestedGeneration: "7",
          platform: "windows",
        },
      },
      {
        channel: "server-to-host",
        value: {
          contractVersion: 1,
          kind: "create",
          sessionId: SESSION,
          hostGeneration: "7",
          scope: { kind: "workspace", workspaceId: SESSION },
          executable: "pwsh.exe",
          arguments: [],
          cwd: "C:\\repo",
          cols: 80,
          rows: 24,
          env: [],
        },
      },
      {
        channel: "host-to-server",
        value: {
          contractVersion: 1,
          kind: "running",
          sessionId: SESSION,
          hostGeneration: "7",
          rootPid: 42,
          processGroupId: "job-42",
          containment: "job-object",
        },
      },
      { channel: "attachment", value: outputFrame },
      {
        channel: "host-to-server",
        value: {
          contractVersion: 1,
          kind: "exit",
          sessionId: SESSION,
          hostGeneration: "7",
          finalOutputSeq: "1",
          code: 0,
          signal: null,
          reason: "natural",
        },
      },
      {
        channel: "attachment",
        value: {
          ...outputFrame,
          kind: "exitBarrier",
          relatedSeq: "1",
          payload: encoder.encode(
            JSON.stringify({
              finalOutputSeq: "1",
              exit: { code: 0, signal: null, reason: "natural" },
            }),
          ),
        },
      },
    ]);

    expect(result.hostMessages.map((message) => message.kind)).toEqual(["handshake", "create"]);
    expect(result.hostEvents.map((event) => event.kind)).toEqual(["running", "exit"]);
    expect(result.attachmentFrames).toEqual([
      outputFrame,
      expect.objectContaining({ kind: "exitBarrier", primarySeq: "1", relatedSeq: "1" }),
    ]);
    expect(
      executeTerminalTransitionTrace(TERMINAL_SESSION_TRANSITIONS, null, [
        "create-accepted",
        "host-running",
        "natural-exit",
        "exit-flushed",
        "explicit-close",
      ]),
    ).toEqual(["starting", "running", "exiting", "exited", null]);
  });

  it("fails a stale generation closed and executes bounded host replacement", () => {
    expect(() =>
      executeTerminalV1ProtocolTrace("8", [
        {
          channel: "host-to-server",
          value: {
            contractVersion: 1,
            kind: "failure",
            hostGeneration: "7",
            boundary: "output",
            recoverable: true,
            code: "HOST_UNHEALTHY",
          },
        },
      ]),
    ).toThrow(/generation/i);

    expect(
      executeTerminalTransitionTrace(TERMINAL_BOOT_TRANSITIONS, "modern-selected", [
        "host-unhealthy",
        "replacement-ready",
      ]),
    ).toEqual(["modern-recovering", "modern-selected"]);
  });

  it("rejects traces that exceed the executable trace bound", () => {
    const steps = Array.from({ length: 257 }, () => ({
      channel: "server-to-host" as const,
      value: {
        contractVersion: 1,
        kind: "probe",
        hostGeneration: "7",
        nonce: "11111111-1111-4111-8111-111111111111",
      },
    }));

    expect(() => executeTerminalV1ProtocolTrace("7", steps)).toThrow(/256/);
  });
});
