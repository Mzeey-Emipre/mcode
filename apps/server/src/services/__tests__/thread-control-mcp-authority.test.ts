import { describe, expect, it } from "vitest";
import { InternalThreadControlMcpAuthority } from "../thread-control-mcp-authority.js";

describe("InternalThreadControlMcpAuthority", () => {
  it("keeps one opaque credential per pooled session while rotating its active turn lease", () => {
    const authority = new InternalThreadControlMcpAuthority();

    const first = authority.activate({
      sessionId: "mcode-source",
      sourceThreadId: "source",
      sourceTurnId: "turn-one",
      sourceProviderId: "claude",
      permissionMode: "supervised",
    });
    const retry = authority.activate({
      sessionId: "mcode-source",
      sourceThreadId: "source",
      sourceTurnId: "turn-one",
      sourceProviderId: "claude",
      permissionMode: "supervised",
    });
    const nextTurn = authority.activate({
      sessionId: "mcode-source",
      sourceThreadId: "source",
      sourceTurnId: "turn-two",
      sourceProviderId: "claude",
      permissionMode: "full",
    });

    expect(retry.credential).toBe(first.credential);
    expect(nextTurn.credential).toBe(first.credential);
    expect(authority.authorize(first.credential, "call-1")).toMatchObject({
      userId: "local-user",
      sourceTurnId: "turn-two",
      sourceToolCallId: "call-1",
      permissionMode: "full",
    });
  });

  it("fails closed after revocation", () => {
    const authority = new InternalThreadControlMcpAuthority();
    const lease = authority.activate({
      sessionId: "mcode-source",
      sourceThreadId: "source",
      sourceTurnId: "turn-one",
      sourceProviderId: "codex",
      permissionMode: "supervised",
    });

    authority.revoke("mcode-source");

    expect(authority.authorize(lease.credential, "call-1")).toBeUndefined();
  });
});
