import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { BROWSER_AUTOMATION_CONTRACT_VERSION, BROWSER_AUTOMATION_OPERATIONS } from "@mcode/contracts";
import { BrowserAutomationBroker } from "../features/browser-automation/index.js";
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
    executorDescriptor: {
      runtime: "electron",
      operations: ["inspect", ...BROWSER_AUTOMATION_OPERATIONS],
      constraints: { maxTabs: 32, maxSnapshotChars: 20_000, maxDiagnostics: 200 },
      capabilityRevision: 1,
    },
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

  it("rejects web host registration unless authorization explicitly opts in", async () => {
    const broker = new BrowserAutomationBroker({ send: () => true });
    const deps = { browserAutomationBroker: broker } as unknown as RouterDeps;
    const client = {} as WebSocket;
    const webRegistration = {
      ...registration("desktop-web", ["workspace-a"], "worktree-trusted"),
      runtime: "web",
      executorDescriptor: {
        ...registration("desktop-web", ["workspace-a"], "worktree-trusted").executorDescriptor,
        runtime: "web",
      },
      targetIdentity: {
        worktreeIdentity: "worktree-trusted",
        connectionId: "pending-desktop",
        workspaceId: "workspace-a",
        threadId: "thread-a",
        tabId: "tab-a",
        generation: 1,
      },
    };
    const disabled = await routeMessage(JSON.stringify({
      id: "web-disabled",
      method: "browserAutomation.host.register",
      params: { registration: webRegistration },
    }), deps, {
      client,
      browserAutomationAuthorization: {
        desktopInstanceId: "desktop-trusted",
        worktreeIdentity: "worktree-trusted",
        allowedWorkspaceIds: ["workspace-a"],
      },
    });
    expect(disabled).toMatchObject({ id: "web-disabled", error: { code: "INTERNAL_ERROR" } });

    const enabled = await routeMessage(JSON.stringify({
      id: "web-enabled",
      method: "browserAutomation.host.register",
      params: { registration: webRegistration },
    }), deps, {
      client,
      browserAutomationAuthorization: {
        desktopInstanceId: "desktop-trusted",
        worktreeIdentity: "worktree-trusted",
        allowedWorkspaceIds: ["workspace-a"],
        allowWebRuntime: true,
      },
    });
    expect(enabled).toMatchObject({ id: "web-enabled", result: { generation: 1 } });
    broker.disconnect(client);
  });

  it("keeps production-style authorization closed even when the env flag would be truthy", async () => {
    const broker = new BrowserAutomationBroker({ send: () => true });
    const deps = { browserAutomationBroker: broker } as unknown as RouterDeps;
    const response = await routeMessage(JSON.stringify({
      id: "production-web",
      method: "browserAutomation.host.register",
      params: { registration: { ...registration(), runtime: "web" } },
    }), deps, {
      client: {} as WebSocket,
      browserAutomationAuthorization: {
        desktopInstanceId: "desktop-production",
        worktreeIdentity: "worktree-production",
        allowedWorkspaceIds: ["workspace-a"],
        allowWebRuntime: false,
      },
    });
    expect(response).toMatchObject({ id: "production-web", error: { code: "INTERNAL_ERROR" } });
    expect(broker.status().hosts).toBe(0);
  });
});
