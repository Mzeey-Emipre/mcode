import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { AgentPermissionService } from "../agent-permission-service.js";

describe("AgentPermissionService", () => {
  it("validates decisions before forwarding them to AgentService", () => {
    const agentService = {
      respondToPermission: vi.fn(),
      listPendingPermissions: vi.fn(() => []),
    };
    const permissions = new AgentPermissionService(agentService as never);

    permissions.respondToPermission("request-1", "allow");

    expect(agentService.respondToPermission).toHaveBeenCalledWith("request-1", "allow");
    expect(() => permissions.respondToPermission("request-1", "invalid" as never)).toThrow();
  });

  it("validates pending requests returned by AgentService", () => {
    const pendingRequest = {
      requestId: "request-1",
      threadId: "thread-1",
      toolName: "Bash",
      input: { command: "bun test" },
    };
    const agentService = {
      respondToPermission: vi.fn(),
      listPendingPermissions: vi.fn(() => [pendingRequest]),
    };
    const permissions = new AgentPermissionService(agentService as never);

    expect(permissions.listPendingPermissions("thread-1")).toEqual([pendingRequest]);
    expect(agentService.listPendingPermissions).toHaveBeenCalledWith("thread-1");
  });

  it("rejects malformed pending requests returned by AgentService", () => {
    const agentService = {
      respondToPermission: vi.fn(),
      listPendingPermissions: vi.fn(() => [{
        requestId: "request-1",
        threadId: "thread-1",
        input: { command: "bun test" },
      }]),
    };
    const permissions = new AgentPermissionService(agentService as never);

    expect(() => permissions.listPendingPermissions("thread-1")).toThrow();
  });
});
