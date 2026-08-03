import { describe, expect, it } from "vitest";
import {
  BROWSER_AUTOMATION_CONTRACT_VERSION,
  BROWSER_AUTOMATION_OPERATIONS,
  WS_CHANNELS,
  WS_METHODS,
} from "../../index.js";

function registration() {
  return {
    contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
    hostId: "host-a",
    desktopInstanceId: "desktop-a",
    worktreeIdentity: "worktree-a",
    workspaceIds: ["workspace-a"],
    executorDescriptor: {
      runtime: "electron",
      operations: ["inspect", ...BROWSER_AUTOMATION_OPERATIONS],
      constraints: { maxTabs: 32, maxSnapshotChars: 20_000, maxDiagnostics: 200 },
      capabilityRevision: 1,
    },
    capabilities: BROWSER_AUTOMATION_OPERATIONS.map((operation) => ({ operation, available: true })),
    maxPendingRequests: 4,
    connectedAt: 1,
  };
}

describe("browser automation WebSocket contracts", () => {
  it("validates host registration and directed request envelopes", () => {
    expect(WS_METHODS()["browserAutomation.host.register"].params.safeParse({ registration: registration() }).success).toBe(true);
    expect(WS_CHANNELS["browserAutomation.request"].safeParse({
      hostId: "host-a",
      generation: 1,
      dispatch: {
        scope: { workspaceId: "workspace-a", threadId: "thread-a", providerSessionId: "provider-a", providerInstanceId: "mcode-a" },
        connection: { desktopInstanceId: "desktop-a", windowId: 1, connectionGeneration: 1, targetGeneration: 0 },
        target: {
          desktopInstanceId: "desktop-a",
          windowId: 1,
          connectionGeneration: 1,
          threadId: "thread-a",
          tabId: "tab-a",
          targetGeneration: 0,
          active: true,
          focused: true,
          lastUsedAt: 10,
        },
        request: {
          contractVersion: 1,
          workspaceId: "workspace-a",
          threadId: "thread-a",
          providerSessionId: "provider-a",
          providerInstanceId: "mcode-a",
          requestId: "request-a",
          sequence: 1,
          deadline: 100,
          expectedControlEpoch: 0,
          operation: "status",
          args: {},
        },
      },
    }).success).toBe(true);
  });

  it("rejects duplicate host capabilities and stale generations", () => {
    const duplicate = registration();
    duplicate.capabilities = [duplicate.capabilities[0]!, duplicate.capabilities[0]!];
    expect(WS_METHODS()["browserAutomation.host.register"].params.safeParse({ registration: duplicate }).success).toBe(false);
    expect(WS_METHODS()["browserAutomation.host.heartbeat"].params.safeParse({
      hostId: "host-a",
      generation: 0,
      observedAt: 1,
    }).success).toBe(false);
  });

  it("accepts targetless cancellation while an open request is creating its tab", () => {
    expect(WS_CHANNELS["browserAutomation.cancel"].safeParse({
      hostId: "host-a",
      generation: 1,
      requestId: "request-a",
      sequence: 1,
      reason: "deadline-exceeded",
    }).success).toBe(true);
  });

  it("directs provider-session cleanup to the owning Browser host", () => {
    expect(WS_CHANNELS["browserAutomation.sessionRelease"].safeParse({
      hostId: "host-a",
      generation: 1,
      providerSessionId: "provider-a",
      reason: "credential-revoked",
    }).success).toBe(true);
    expect(WS_CHANNELS["browserAutomation.sessionRelease"].safeParse({
      hostId: "host-a",
      generation: 1,
      providerSessionId: "provider-a",
      reason: "unknown",
    }).success).toBe(false);
  });
});
