import { describe, expect, it } from "vitest";
import { BROWSER_V2_CORE_OPERATIONS } from "@mcode/contracts";
import {
  BrowserAutomationSessionLease,
  type BrowserAutomationSessionLeaseScope,
} from "../browser-automation-session-lease.js";
import { BrowserAutomationCredentialRegistry } from "../credential-registry.js";

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

  it("grants the ordered Browser v2 surface without duplicates", () => {
    const lease = configuredLease();
    const interact = lease.issue(scope({ permissionCapability: "interact" }))!;
    const privileged = lease.issue(scope({
      permissionCapability: "privileged",
      providerId: "privileged-provider",
      mcodeSessionId: "privileged-mcode",
    }))!;

    expect(interact.allowedOperations).toEqual(BROWSER_V2_CORE_OPERATIONS);
    expect(interact.allowedOperations).not.toContain("evaluate");
    expect(new Set(interact.allowedOperations).size).toBe(interact.allowedOperations.length);
    expect(privileged.allowedOperations.slice(0, 4)).toEqual(BROWSER_V2_CORE_OPERATIONS);
    expect(privileged.allowedOperations).toContain("evaluate");
    expect(privileged.allowedOperations).toEqual([...BROWSER_V2_CORE_OPERATIONS, "evaluate"]);
    expect(new Set(privileged.allowedOperations).size).toBe(privileged.allowedOperations.length);
  });

  it("advertises browser_tabs for interact and privileged leases, but not observe", () => {
    const lease = configuredLease();
    const observe = lease.issue(lease.stage({ ...scope(), permissionCapability: "observe" }))!;
    const interact = lease.issue(lease.stage({ ...scope(), permissionCapability: "interact", providerSessionId: "interact-session" }))!;
    const privileged = lease.issue(lease.stage({ ...scope(), permissionCapability: "privileged", providerSessionId: "privileged-session" }))!;
    expect(observe.allowedOperations).not.toContain("tabs");
    expect(interact.allowedOperations).toContain("tabs");
    expect(privileged.allowedOperations).toContain("tabs");
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

  it("reports a lease inactive after registry revocation", () => {
    const lease = configuredLease();
    const grant = lease.issue(scope())!;

    expect(lease.isActive(grant.leaseId)).toBe(true);
    lease.credentials.revoke(grant.credentialId);
    expect(lease.isActive(grant.leaseId)).toBe(false);
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
