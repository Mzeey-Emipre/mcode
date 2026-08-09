import { describe, expect, it } from "vitest";
import {
  decodeTerminalFrame,
  encodeTerminalFrame,
  TERMINAL_BINARY_FRAME_KINDS,
  type TerminalBinaryFrame,
} from "../terminal-binary.js";

const SESSION = "abcdef12-abcd-4abc-8abc-abcdefabcdef";
const ATTACHMENT = "12345678-abcd-4abc-8abc-abcdefabcdef";
const HYDRATION = "87654321-abcd-4abc-8abc-abcdefabcdef";
const UPLOAD = "aaaaaaaa-abcd-4abc-8abc-abcdefabcdef";
const encoder = new TextEncoder();

const validFrame = (kind: keyof typeof TERMINAL_BINARY_FRAME_KINDS): TerminalBinaryFrame => {
  const base = {
    kind,
    sessionId: SESSION,
    attachmentId: ATTACHMENT,
    hostGeneration: "18446744073709551615",
    attachmentEpoch: "1",
    primarySeq: "2",
    relatedSeq: "0",
    payload: new Uint8Array([0x61]),
  } satisfies TerminalBinaryFrame;
  switch (kind) {
    case "resize":
      return { ...base, payload: new Uint8Array([0, 80, 0, 24]) };
    case "outputAck":
    case "commandAck":
      return { ...base, payload: new Uint8Array() };
    case "checkpointChunk":
      return { ...base, uploadId: UPLOAD, primarySeq: "0", relatedSeq: "1" };
    case "hydrationChunk":
      return { ...base, hydrationId: HYDRATION, primarySeq: "0", relatedSeq: "1" };
    case "hydrationComplete":
      return {
        ...base,
        hydrationId: HYDRATION,
        payload: encoder.encode(
          JSON.stringify({
            hydrationId: HYDRATION,
            mode: "delta",
            requestedAfterSeq: "0",
            checkpointThroughSeq: null,
            firstOutputSeq: "1",
            lastOutputSeq: "2",
            gap: null,
            chunkCount: 1,
            totalBytes: 1,
          }),
        ),
      };
    case "state":
      return { ...base, payload: encoder.encode(JSON.stringify({ state: "running", exit: null })) };
    case "gap":
      return {
        ...base,
        hydrationId: HYDRATION,
        primarySeq: "1",
        relatedSeq: "2",
        payload: encoder.encode(
          JSON.stringify({
            kind: "replay",
            firstMissingSeq: "1",
            lastMissingSeq: "2",
            retainedFromSeq: "3",
            retainedThroughSeq: "4",
            reason: "evicted",
          }),
        ),
      };
    case "exitBarrier":
      return {
        ...base,
        payload: encoder.encode(
          JSON.stringify({
            finalOutputSeq: "2",
            exit: { code: 0, signal: null, reason: "natural" },
          }),
        ),
      };
    default:
      return base;
  }
};

describe("Terminal v1 binary codec", () => {
  it("round-trips every frame kind with canonical u64 fields", () => {
    for (const kind of Object.keys(TERMINAL_BINARY_FRAME_KINDS) as Array<
      keyof typeof TERMINAL_BINARY_FRAME_KINDS
    >) {
      expect(decodeTerminalFrame(encodeTerminalFrame(validFrame(kind)))).toEqual(validFrame(kind));
    }
  });

  it("rejects unknown flags, trailing bytes, and missing required IDs", () => {
    const encoded = encodeTerminalFrame(validFrame("input"));
    const flagged = new Uint8Array(encoded);
    flagged[5] = 1;
    expect(() => decodeTerminalFrame(flagged)).toThrow(/flags/i);
    const trailing = new Uint8Array(encoded.length + 1);
    trailing.set(encoded);
    expect(() => decodeTerminalFrame(trailing)).toThrow(/length|trailing/i);
    expect(() => encodeTerminalFrame({ ...validFrame("checkpointChunk"), uploadId: undefined })).toThrow(
      /upload/i,
    );
  });

  it("rejects invalid resize bounds and malformed strict JSON payloads", () => {
    expect(() =>
      encodeTerminalFrame({ ...validFrame("resize"), payload: new Uint8Array([0, 0, 0, 24]) }),
    ).toThrow(/resize/i);
    expect(() =>
      encodeTerminalFrame({ ...validFrame("state"), payload: encoder.encode('{"state":"running"}') }),
    ).toThrow(/state|payload/i);
    expect(() =>
      encodeTerminalFrame({ ...validFrame("input"), relatedSeq: "1" }),
    ).toThrow(/related/i);
    expect(() =>
      encodeTerminalFrame({ ...validFrame("gap"), primarySeq: "9", relatedSeq: "10" }),
    ).toThrow(/gap|sequence/i);
  });
});
