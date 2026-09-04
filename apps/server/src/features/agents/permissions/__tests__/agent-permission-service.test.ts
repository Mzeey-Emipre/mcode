import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { AgentPermissionService } from "../agent-permission-service.js";

describe("AgentPermissionService", () => {
  it("validates decisions before forwarding them to the provider that owns the request", () => {
    const provider = { resolvePermission: vi.fn(() => true) };
    const permissions = new AgentPermissionService({ resolveAll: vi.fn(() => [provider]) } as never);

    permissions.respondToPermission("request-1", "allow");

    expect(provider.resolvePermission).toHaveBeenCalledWith("request-1", "allow");
    expect(() => permissions.respondToPermission("request-1", "invalid" as never)).toThrow();
  });

  it("forwards validated question answers without changing their labels", () => {
    const provider = { resolvePermission: vi.fn(() => true) };
    const permissions = new AgentPermissionService({ resolveAll: vi.fn(() => [provider]) } as never);

    permissions.respondToPermission("question-1", "allow", [[" staging "]]);

    expect(provider.resolvePermission).toHaveBeenCalledWith("question-1", "allow", [[" staging "]]);
    expect(() => permissions.respondToPermission("question-1", "allow", [["  "]] as never)).toThrow();
  });

  it("validates pending requests returned by providers", () => {
    const pendingRequest = {
      requestId: "request-1",
      threadId: "thread-1",
      toolName: "Bash",
      input: { command: "bun test" },
    };
    const provider = { listPendingPermissions: vi.fn(() => [pendingRequest]) };
    const permissions = new AgentPermissionService({ resolveAll: vi.fn(() => [provider]) } as never);

    expect(permissions.listPendingPermissions("thread-1")).toEqual([pendingRequest]);
    expect(provider.listPendingPermissions).toHaveBeenCalledWith("thread-1");
  });

  it("rejects malformed pending requests returned by providers", () => {
    const provider = {
      listPendingPermissions: vi.fn(() => [{
        requestId: "request-1",
        threadId: "thread-1",
        input: { command: "bun test" },
      }]),
    };
    const permissions = new AgentPermissionService({ resolveAll: vi.fn(() => [provider]) } as never);

    expect(() => permissions.listPendingPermissions("thread-1")).toThrow();
  });
});
