import { describe, expect, it } from "vitest";
import {
  BrowserAutomationSessionLease,
  type BrowserAutomationSessionLeaseScope,
} from "./browser-automation-session-lease.js";
import { BrowserAutomationCredentialRegistry } from "./credential-registry.js";

const scope = (overrides: Partial<BrowserAutomationSessionLeaseScope> = {}) => ({
  providerId: "codex",
  providerSessionId: "provider-a",
  mcodeSessionId: "mcode-a",
  threadId: "thread-a",
  workspaceId: "workspace-a",
  permissionCapability: "interact" as const,
  ...overrides,
});

function configuredLease(options: ConstructorParameters<typeof BrowserAutomationSessionLease>[0] = {}) {
  const lease = new BrowserAutomationSessionLease(options);
  lease.configure({ mcpUrl: "http://127.0.0.1:19400/mcp", worktreeIdentity: "worktree-a" });
  return lease;
}

describe("BrowserAutomationSessionLease", () => {
  it("stages, issues, refreshes, and releases one lease", () => {
    const lease = configuredLease();
    const staged = lease.stage(scope());
    expect(staged.leaseId).toBeTypeOf("string");
    const grant = lease.issue(staged)!;
    expect(grant.leaseId).toBe(staged.leaseId);
    expect(lease.credentials.authenticate(grant.token)?.threadId).toBe("thread-a");

    const refreshed = lease.refresh(grant.leaseId);
    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) return;
    expect(refreshed.grant.credentialId).not.toBe(grant.credentialId);
    expect(lease.credentials.authenticate(grant.token)).toBeNull();
    expect(lease.credentials.authenticate(refreshed.grant.token)?.workspaceId).toBe("workspace-a");

    expect(lease.release(grant.leaseId)).toMatchObject({ released: true, leaseId: grant.leaseId });
    expect(lease.status()).toEqual({ active: 0, pending: 0 });
  });

  it("keeps credentials isolated by logical session while rotating one session", () => {
    const lease = configuredLease();
    const first = lease.issue(scope())!;
    const second = lease.issue(scope({
      providerId: "claude",
      providerSessionId: "provider-b",
      mcodeSessionId: "mcode-b",
      threadId: "thread-b",
    }))!;
    const rotated = lease.issue(scope({ permissionCapability: "privileged" }))!;

    expect(lease.credentials.authenticate(first.token)).toBeNull();
    expect(lease.credentials.authenticate(second.token)?.threadId).toBe("thread-b");
    expect(lease.credentials.authenticate(rotated.token)?.allowedOperations).toContain("evaluate");
    expect(lease.status()).toEqual({ active: 2, pending: 0 });
  });

  it("cleans a staged scope when registry issuance fails", () => {
    const lease = configuredLease();
    const staged = lease.stage(scope({
      permissionCapability: "interact",
      allowedOperations: ["evaluate"],
    }));

    expect(() => lease.issue(staged)).toThrow(/Evaluate requires/);
    expect(lease.status()).toEqual({ active: 0, pending: 0 });
  });

  it("expires pending scopes and releases every credential on shutdown", () => {
    let now = 100;
    const registry = new BrowserAutomationCredentialRegistry({ idleTtlMs: 10, absoluteTtlMs: 100, now: () => now });
    const lease = configuredLease({ credentials: registry, pendingTtlMs: 5, now: () => now });
    const grant = lease.issue(scope({ mcodeSessionId: "mcode-live" }))!;
    const pending = lease.stage(scope());
    now = 106;
    expect(lease.issue(pending)).toBeNull();
    now = 111;
    expect(registry.size()).toBe(0);
    expect(lease.status()).toEqual({ active: 0, pending: 0 });

    lease.issue(scope({ mcodeSessionId: "mcode-second" }));
    lease.shutdown();
    expect(registry.authenticate(grant.token)).toBeNull();
    expect(lease.status()).toEqual({ active: 0, pending: 0 });
  });
});
