import { describe, expect, it } from "vitest";
import { formatOpenCodeResumeCursor, parseOpenCodeResumeCursor } from "../opencode-resume-cursor.js";

describe("parseOpenCodeResumeCursor", () => {
  it("adopts a plain upstream session id as legacy v1", () => {
    expect(parseOpenCodeResumeCursor("ses_abc123")).toBe("ses_abc123");
  });

  it("adopts a JSON-encoded v1 cursor", () => {
    expect(parseOpenCodeResumeCursor(JSON.stringify({ schemaVersion: 1, sessionId: "ses_abc123" }))).toBe(
      "ses_abc123",
    );
  });

  it("ignores an unknown schema version instead of misreading it", () => {
    expect(parseOpenCodeResumeCursor(JSON.stringify({ schemaVersion: 2, sessionId: "ses_abc123" }))).toBeUndefined();
    expect(parseOpenCodeResumeCursor({ schemaVersion: 99, sessionId: "ses_abc123" })).toBeUndefined();
  });

  it("ignores values without a ses_ session id", () => {
    expect(parseOpenCodeResumeCursor("cursor-session-1")).toBeUndefined();
    expect(parseOpenCodeResumeCursor(JSON.stringify({ schemaVersion: 1, sessionId: "nope" }))).toBeUndefined();
    expect(parseOpenCodeResumeCursor("")).toBeUndefined();
    expect(parseOpenCodeResumeCursor(null)).toBeUndefined();
    expect(parseOpenCodeResumeCursor(undefined)).toBeUndefined();
    expect(parseOpenCodeResumeCursor(42)).toBeUndefined();
  });
});

describe("formatOpenCodeResumeCursor", () => {
  it("rejects non-session ids instead of persisting garbage", () => {
    expect(() => formatOpenCodeResumeCursor("nope")).toThrow();
    expect(() => formatOpenCodeResumeCursor("")).toThrow();
  });
});
