import { describe, expect, it } from "vitest";
import { TerminalBackendCapabilitiesSchema } from "../../models/terminal-backend.js";
import { WS_METHODS } from "../methods.js";

const LEGACY_CAPABILITIES = {
  contractVersion: 0,
  backend: "legacy",
  publicFrameVersion: 0,
  recovery: { replay: true, checkpoint: true, gap: true },
} as const;

describe("Terminal backend capabilities", () => {
  it("reports the bounded legacy protocol without accepting unknown fields", () => {
    expect(TerminalBackendCapabilitiesSchema().parse(LEGACY_CAPABILITIES)).toEqual(
      LEGACY_CAPABILITIES,
    );
    expect(() =>
      TerminalBackendCapabilitiesSchema().parse({ ...LEGACY_CAPABILITIES, mode: "modern" }),
    ).toThrow();
  });

  it("registers capability reporting beside the frozen legacy methods", () => {
    expect(WS_METHODS()["terminal.capabilities"].result.parse(LEGACY_CAPABILITIES)).toEqual(
      LEGACY_CAPABILITIES,
    );
    expect(WS_METHODS()["terminal.create"].params.parse({ threadId: "thread-1" })).toEqual({
      threadId: "thread-1",
    });
  });

  it("accepts the protected failed-host observation without changing legacy versioning", () => {
    const capabilities = { ...LEGACY_CAPABILITIES, releaseTest: { hostPid: 77 } };

    expect(TerminalBackendCapabilitiesSchema().parse(capabilities)).toEqual(capabilities);
    expect(WS_METHODS()["terminal.capabilities"].result.parse(capabilities)).toEqual(capabilities);
  });
});
