import { describe, it, expect } from "vitest";
import {
  encodeTerminalDataFrame,
  decodeTerminalDataFrame,
  TERMINAL_DATA_TAG,
} from "../terminal-legacy-binary.js";

describe("encodeTerminalDataFrame / decodeTerminalDataFrame", () => {
  it("round-trips a short ASCII payload", () => {
    const ptyId = "11111111-1111-4111-8111-111111111111";
    const payload = new Uint8Array([0x68, 0x69]); // "hi"
    const frame = encodeTerminalDataFrame(ptyId, 7, payload);
    expect(frame[0]).toBe(TERMINAL_DATA_TAG);
    const decoded = decodeTerminalDataFrame(frame);
    expect(decoded).toEqual({ ptyId, seq: 7, payload });
  });

  it("round-trips a multi-byte UTF-8 sequence split at an arbitrary index", () => {
    // U+1F600 grinning face = F0 9F 98 80
    const ptyId = "abcdabcd-abcd-4abc-8abc-abcdabcdabcd";
    const payload = new Uint8Array([0xf0, 0x9f, 0x98, 0x80]);
    const decoded = decodeTerminalDataFrame(
      encodeTerminalDataFrame(ptyId, 0, payload),
    );
    expect(decoded.payload).toEqual(payload);
  });

  it("rejects frames with a wrong tag", () => {
    const buf = new Uint8Array([0x00, 0x00]);
    expect(() => decodeTerminalDataFrame(buf)).toThrow(/tag/i);
  });

  it("rejects truncated frames", () => {
    // tag + ptyIdLen=36 but buffer is too short
    const buf = new Uint8Array([0x01, 36, 0]);
    expect(() => decodeTerminalDataFrame(buf)).toThrow(/truncat/i);
  });
});
