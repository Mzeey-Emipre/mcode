import { describe, expect, it } from "vitest";
import { BROWSER_AUTOMATION_OPERATIONS } from "@mcode/contracts";
import { BrowserAutomationCredentialRegistry } from "../credential-registry.js";

function scope(session = "provider-session") {
  return {
    providerId: "cursor",
    providerSessionId: session,
    mcodeSessionId: "mcode-session",
    threadId: "thread-a",
    workspaceId: "workspace-a",
    worktreeIdentity: "worktree-a",
    permissionCapability: "privileged" as const,
    allowedOperations: [...BROWSER_AUTOMATION_OPERATIONS],
  };
}

describe("BrowserAutomationCredentialRegistry", () => {
  it("authenticates the right opaque token and preserves every scope boundary", () => {
    const registry = new BrowserAutomationCredentialRegistry();
    const issued = registry.issue(scope());

    expect(registry.authenticate("not-the-token")).toBeNull();
    expect(registry.authenticate(issued.token)).toMatchObject({
      credentialId: issued.credentialId,
      providerId: "cursor",
      providerSessionId: "provider-session",
      mcodeSessionId: "mcode-session",
      threadId: "thread-a",
      workspaceId: "workspace-a",
      worktreeIdentity: "worktree-a",
    });
  });

  it("rejects expired and revoked credentials", () => {
    let now = 100;
    const registry = new BrowserAutomationCredentialRegistry({
      idleTtlMs: 10,
      absoluteTtlMs: 100,
      now: () => now,
    });
    const revoked = registry.issue(scope("revoked"));
    const expired = registry.issue(scope("expired"));
    expect(registry.revoke(revoked.credentialId)).toBe(true);
    expect(registry.authenticate(revoked.token)).toBeNull();
    now = 111;
    expect(registry.authenticate(expired.token)).toBeNull();
    expect(registry.size()).toBe(0);
  });

  it("touches live credentials and revokes one provider session without crossing sessions", () => {
    let now = 1_000;
    const registry = new BrowserAutomationCredentialRegistry({
      idleTtlMs: 100,
      absoluteTtlMs: 1_000,
      now: () => now,
    });
    const first = registry.issue(scope("first"));
    const second = registry.issue(scope("second"));
    now = 1_050;
    expect(registry.touch(first.credentialId)).toBe(true);
    expect(registry.revokeProviderSession("cursor", "second")).toBe(1);
    expect(registry.authenticate(second.token)).toBeNull();
    now = 1_101;
    expect(registry.authenticate(first.token)).not.toBeNull();
  });

  it("extends idle expiry on use without extending the absolute lifetime", () => {
    let now = 1_000;
    const registry = new BrowserAutomationCredentialRegistry({
      idleTtlMs: 100,
      absoluteTtlMs: 250,
      now: () => now,
    });
    const issued = registry.issue(scope("bounded-lifetime"));

    now = 1_090;
    expect(registry.authenticate(issued.token)).not.toBeNull();
    now = 1_180;
    expect(registry.authenticate(issued.token)).not.toBeNull();
    now = 1_251;
    expect(registry.authenticate(issued.token)).toBeNull();
  });

  it("evicts the least recently used digest when the bounded capacity is full", () => {
    let now = 1;
    const registry = new BrowserAutomationCredentialRegistry({ maxCredentials: 2, now: () => now });
    const first = registry.issue(scope("first"));
    now++;
    const second = registry.issue(scope("second"));
    now++;
    expect(registry.authenticate(first.token)).not.toBeNull();
    now++;
    const third = registry.issue(scope("third"));

    expect(registry.authenticate(first.token)).not.toBeNull();
    expect(registry.authenticate(second.token)).toBeNull();
    expect(registry.authenticate(third.token)).not.toBeNull();
    expect(registry.size()).toBe(2);
  });

  it("rejects duplicate operations and evaluate without privileged permission", () => {
    const registry = new BrowserAutomationCredentialRegistry();
    expect(() => registry.issue({ ...scope(), allowedOperations: ["inspect", "inspect"] })).toThrow();
    expect(() => registry.issue({ ...scope(), permissionCapability: "interact", allowedOperations: ["evaluate"] })).toThrow();
    expect(() => registry.issue({ ...scope(), permissionCapability: "observe", allowedOperations: ["evaluate"] })).toThrow();
  });

  it("allows browser_tabs only for mutation-capable credentials", () => {
    const registry = new BrowserAutomationCredentialRegistry();
    const interact = registry.issue({
      ...scope(),
      permissionCapability: "interact",
      allowedOperations: ["tabs"],
    });
    expect(registry.authenticate(interact.token)?.allowedOperations).toEqual(["tabs"]);
    expect(() => registry.issue({
      ...scope(),
      permissionCapability: "observe",
      allowedOperations: ["tabs"],
    })).toThrow();
  });

  it("stays bounded under concurrent issuance", async () => {
    const registry = new BrowserAutomationCredentialRegistry({ maxCredentials: 16 });
    await Promise.all(
      Array.from({ length: 100 }, (_, index) => Promise.resolve(registry.issue(scope(`session-${index}`)))),
    );
    expect(registry.size()).toBe(16);
  });
});
