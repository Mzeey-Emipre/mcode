import { describe, expect, it } from "vitest";
import { isInternalThreadTargetAllowed } from "../index.js";

describe("internal thread authority", () => {
  it("excludes its source thread", () => {
    const authority = {
      type: "internal" as const,
      userId: "local-user" as const,
      sourceThreadId: "source",
      sourceTurnId: "turn",
      sourceToolCallId: "call",
      sourceProviderId: "codex",
      permissionMode: "full" as const,
    };
    expect(isInternalThreadTargetAllowed(authority, "source")).toBe(false);
    expect(isInternalThreadTargetAllowed(authority, "other")).toBe(true);
  });
});
