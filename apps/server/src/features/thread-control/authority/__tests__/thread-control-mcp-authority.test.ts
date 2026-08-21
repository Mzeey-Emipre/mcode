import { describe, expect, it } from "vitest";
import { constantTimeCredentialEqual, InternalThreadControlMcpAuthority } from "../thread-control-mcp-authority.js";

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
      type: "internal",
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

  it("denies an ineligible turn from the start without inheriting a prior grant", () => {
    const authority = new InternalThreadControlMcpAuthority();
    const ineligible = authority.activate({
      sessionId: "mcode-source",
      sourceThreadId: "source",
      sourceTurnId: "child-turn",
      sourceProviderId: "codex",
      permissionMode: "supervised",
      eligible: false,
    });
    expect(authority.authorize(ineligible.credential, "child-mcp-call")).toBeUndefined();

    const eligible = authority.activate({
      sessionId: "mcode-source",
      sourceThreadId: "source",
      sourceTurnId: "explicit-turn",
      sourceProviderId: "codex",
      permissionMode: "supervised",
      eligible: true,
    });
    expect(authority.authorize(eligible.credential, "parent-mcp-call")).toMatchObject({
      sourceTurnId: "explicit-turn",
    });

    const nextIneligible = authority.activate({
      sessionId: "mcode-source",
      sourceThreadId: "source",
      sourceTurnId: "next-child-turn",
      sourceProviderId: "codex",
      permissionMode: "supervised",
      eligible: false,
    });
    expect(authority.authorize(nextIneligible.credential, "next-child-mcp-call")).toBeUndefined();
  });

  it("rejects unequal credential lengths before constant-time comparison", () => {
    expect(constantTimeCredentialEqual("credential", "credential")).toBe(true);
    expect(constantTimeCredentialEqual("credential", "credential-extra")).toBe(false);
  });
});
