import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { BROWSER_AUTOMATION_CONTRACT_VERSION } from "@mcode/contracts";
import { BrowserAutomationBroker } from "../services/browser-automation/broker.js";
import { routeMessage, type RouterDeps } from "./ws-router.js";

function registration(
  desktopInstanceId = "desktop-untrusted",
  workspaceIds = ["workspace-a"],
  worktreeIdentity = "worktree-untrusted",
) {
  return {
    contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
    hostId: "host-a",
    desktopInstanceId,
    worktreeIdentity,
    workspaceIds,
    capabilities: [{ operation: "status", available: true }],
    maxPendingRequests: 2,
    connectedAt: 1,
  };
}

describe("browser automation router authorization", () => {
  it("passes trusted connection scope separately and returns the assigned identity", async () => {
    const broker = new BrowserAutomationBroker({ send: () => true });
    const deps = { browserAutomationBroker: broker } as unknown as RouterDeps;
    const client = {} as WebSocket;
    const response = await routeMessage(JSON.stringify({
      id: "register",
      method: "browserAutomation.host.register",
      params: { registration: registration("desktop-self-asserted", ["workspace-a"], "worktree-self-asserted") },
    }), deps, {
      client,
      browserAutomationAuthorization: {
        desktopInstanceId: "desktop-trusted",
        worktreeIdentity: "worktree-trusted",
        allowedWorkspaceIds: ["workspace-a"],
      },
    });

    expect(response).toMatchObject({
      id: "register",
      result: { generation: 1, desktopInstanceId: "desktop-trusted" },
    });
    const targetResponse = await routeMessage(JSON.stringify({
      id: "targets",
      method: "browserAutomation.host.updateTargets",
      params: {
        hostId: "host-a",
        generation: 1,
        targets: [{
          desktopInstanceId: "desktop-trusted",
          windowId: 1,
          connectionGeneration: 1,
          threadId: "thread-a",
          tabId: "tab-a",
          targetGeneration: 0,
          active: true,
          focused: true,
          lastUsedAt: 10,
        }],
      },
    }), deps, { client });
    expect(targetResponse).toEqual({ id: "targets", result: undefined });
    broker.disconnect(client);
  });

  it("does not let renderer registration override trusted desktop or workspace scope", async () => {
    const broker = new BrowserAutomationBroker({ send: () => true });
    const deps = { browserAutomationBroker: broker } as unknown as RouterDeps;
    const response = await routeMessage(JSON.stringify({
      id: "register",
      method: "browserAutomation.host.register",
      params: { registration: registration("desktop-forged", ["workspace-forged"]) },
    }), deps, {
      client: {} as WebSocket,
      browserAutomationAuthorization: {
        desktopInstanceId: "desktop-trusted",
        worktreeIdentity: "worktree-trusted",
        allowedWorkspaceIds: ["workspace-a"],
      },
    });

    expect(response).toMatchObject({
      id: "register",
      error: { code: "INTERNAL_ERROR", message: expect.stringContaining("not authorized") },
    });
    expect(broker.status().hosts).toBe(0);
  });
});
