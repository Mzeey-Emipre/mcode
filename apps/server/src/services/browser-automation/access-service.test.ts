import { describe, expect, it, vi } from "vitest";
import {
  BrowserAutomationAccessService,
  browserAutomationPermissionCapability,
} from "./access-service.js";
import { BrowserAutomationCredentialRegistry } from "./credential-registry.js";

function configuredService(): BrowserAutomationAccessService {
  const service = new BrowserAutomationAccessService();
  service.configure({
    mcpUrl: "http://127.0.0.1:19400/mcp",
    worktreeIdentity: "worktree-a",
  });
  return service;
}

describe("BrowserAutomationAccessService", () => {
  it("maps plan, supervised, and full turns to bounded operation sets", () => {
    expect(browserAutomationPermissionCapability("full", "plan")).toBe("observe");
    expect(browserAutomationPermissionCapability("supervised", "build")).toBe("interact");
    expect(browserAutomationPermissionCapability("full", "build")).toBe("privileged");

    const service = configuredService();
    const base = {
      providerId: "cursor",
      providerSessionId: "provider-session",
      mcodeSessionId: "mcode-thread-a",
      threadId: "thread-a",
      workspaceId: "workspace-a",
    };
    const observe = service.issue({ ...base, permissionCapability: "observe" });
    const interact = service.issue({ ...base, permissionCapability: "interact" });
    const privileged = service.issue({ ...base, permissionCapability: "privileged" });

    expect(observe?.allowedOperations).not.toContain("click");
    expect(interact?.allowedOperations).toContain("click");
    expect(interact?.allowedOperations).not.toContain("evaluate");
    expect(privileged?.allowedOperations).toContain("evaluate");
  });

  it("rotates one session without crossing another thread and notifies cleanup once", () => {
    const service = configuredService();
    const revoked = vi.fn();
    service.onCredentialRevoked(revoked);
    const request = {
      providerId: "codex",
      providerSessionId: "provider-a",
      mcodeSessionId: "mcode-a",
      threadId: "thread-a",
      workspaceId: "workspace-a",
      permissionCapability: "interact" as const,
    };
    const first = service.issue(request)!;
    const other = service.issue({
      ...request,
      providerSessionId: "provider-b",
      mcodeSessionId: "mcode-b",
      threadId: "thread-b",
    })!;
    const rotated = service.issue({ ...request, permissionCapability: "privileged" })!;

    expect(rotated.credentialId).not.toBe(first.credentialId);
    expect(service.credentials.authenticate(first.token)).toBeNull();
    expect(service.credentials.authenticate(other.token)?.threadId).toBe("thread-b");
    expect(revoked).toHaveBeenCalledTimes(1);
    expect(revoked).toHaveBeenCalledWith({
      credentialId: first.credentialId,
      providerId: "codex",
      providerSessionId: "provider-a",
    });
    expect(service.revokeCredential(first.credentialId)).toBe(false);
  });

  it("fails closed before configuration and rejects non-loopback endpoints", () => {
    const service = new BrowserAutomationAccessService();
    expect(service.issue({
      providerId: "claude",
      providerSessionId: "provider-a",
      mcodeSessionId: "mcode-a",
      threadId: "thread-a",
      workspaceId: "workspace-a",
      permissionCapability: "observe",
    })).toBeNull();
    expect(() => service.configure({
      mcpUrl: "https://example.com/mcp",
      worktreeIdentity: "worktree-a",
    })).toThrow(/loopback/);
  });

  it("bounds repeated rotations across five concurrent provider sessions", () => {
    const service = configuredService();
    for (let cycle = 0; cycle < 100; cycle++) {
      for (let index = 0; index < 5; index++) {
        service.issue({
          providerId: index % 2 === 0 ? "cursor" : "copilot",
          providerSessionId: `provider-${index}`,
          mcodeSessionId: `mcode-${index}`,
          threadId: `thread-${index}`,
          workspaceId: `workspace-${index}`,
          permissionCapability: cycle % 2 === 0 ? "interact" : "observe",
        });
      }
      expect(service.credentials.size()).toBe(5);
    }
    service.shutdown();
    expect(service.credentials.size()).toBe(0);
  });

  it("does not collide provider and session identifiers containing delimiters", () => {
    const service = configuredService();
    const first = service.issue({
      providerId: "cursor\u0000session",
      providerSessionId: "provider-a",
      mcodeSessionId: "one",
      threadId: "thread-a",
      workspaceId: "workspace-a",
      permissionCapability: "observe",
    });
    const second = service.issue({
      providerId: "cursor",
      providerSessionId: "provider-b",
      mcodeSessionId: "session\u0000one",
      threadId: "thread-b",
      workspaceId: "workspace-a",
      permissionCapability: "observe",
    });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(service.credentials.size()).toBe(2);
    expect(service.revokeSession("cursor\u0000session", "one")).toBe(true);
    expect(service.credentials.authenticate(second!.token)?.threadId).toBe("thread-b");
  });

  it("releases session metadata and notifies cleanup when authentication sweeps an expired credential", () => {
    let now = 100;
    const registry = new BrowserAutomationCredentialRegistry({
      idleTtlMs: 10,
      absoluteTtlMs: 100,
      now: () => now,
    });
    const service = new BrowserAutomationAccessService(registry);
    service.configure({ mcpUrl: "http://127.0.0.1:19400/mcp", worktreeIdentity: "worktree-a" });
    const revoked = vi.fn();
    service.onCredentialRevoked(revoked);
    const grant = service.issue({
      providerId: "cursor",
      providerSessionId: "provider-a",
      mcodeSessionId: "mcode-a",
      threadId: "thread-a",
      workspaceId: "workspace-a",
      permissionCapability: "observe",
    })!;

    now = 111;
    expect(registry.authenticate(grant.token)).toBeNull();
    expect(service.revokeSession("cursor", "mcode-a")).toBe(false);
    expect(revoked).toHaveBeenCalledOnce();
    expect(revoked).toHaveBeenCalledWith({
      credentialId: grant.credentialId,
      providerId: "cursor",
      providerSessionId: "provider-a",
    });
  });
});
