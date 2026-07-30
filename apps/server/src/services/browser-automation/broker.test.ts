import { describe, expect, it, vi } from "vitest";
import {
  BROWSER_AUTOMATION_CONTRACT_VERSION,
  BrowserAutomationHostDispatchSchema,
  type BrowserAutomationHostRegistration,
  type BrowserAutomationRequest,
} from "@mcode/contracts";
import type { WebSocket } from "ws";
import { BrowserAutomationBroker, type BrowserAutomationBrokerOptions } from "./broker.js";
import type { BrowserAutomationCredentialClaims } from "./credential-registry.js";

function socket(name: string): WebSocket {
  return { name } as unknown as WebSocket;
}

function options(overrides: Partial<BrowserAutomationBrokerOptions> = {}): BrowserAutomationBrokerOptions {
  return { ...overrides };
}

function authorization(name: string, allowedWorkspaceIds = ["workspace-a", "workspace-b"]) {
  return { desktopInstanceId: `desktop-${name}`, worktreeIdentity: "worktree-a", allowedWorkspaceIds };
}

function register(
  broker: BrowserAutomationBroker,
  targetSocket: WebSocket,
  hostId: string,
  workspaceId: string,
): number {
  return broker.registerHost(targetSocket, registration(hostId, workspaceId), authorization(hostId)).generation;
}

function updateTargets(
  broker: BrowserAutomationBroker,
  targetSocket: WebSocket,
  hostId: string,
  generation: number,
  threadIds: string[],
): void {
  broker.updateTargets(targetSocket, hostId, generation, threadIds.map((threadId, index) => ({
    desktopInstanceId: `desktop-${hostId}`,
    windowId: index + 1,
    connectionGeneration: generation,
    threadId,
    tabId: `tab-${threadId}`,
    targetGeneration: 0,
    active: index === 0,
    focused: false,
    lastUsedAt: index + 1,
  })));
}

function registration(hostId: string, workspaceId: string): BrowserAutomationHostRegistration {
  return {
    contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
    hostId,
    runtime: "electron",
    desktopInstanceId: `desktop-${hostId}`,
    worktreeIdentity: "worktree-a",
    workspaceIds: [workspaceId],
    capabilities: [{ operation: "status", available: true }],
    maxPendingRequests: 2,
    connectedAt: 1,
  };
}

function claims(threadId: string, workspaceId: string): BrowserAutomationCredentialClaims {
  return {
    credentialId: `credential-${threadId}`,
    providerId: "cursor",
    providerSessionId: `provider-${threadId}`,
    mcodeSessionId: `mcode-${threadId}`,
    threadId,
    workspaceId,
    worktreeIdentity: "worktree-a",
    permissionCapability: "observe",
    allowedOperations: ["status"],
    issuedAt: 1,
    expiresAt: 100_000,
  };
}

function request(scope: BrowserAutomationCredentialClaims, sequence = 1): BrowserAutomationRequest {
  return {
    contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
    workspaceId: scope.workspaceId,
    threadId: scope.threadId,
    providerSessionId: scope.providerSessionId,
    providerInstanceId: scope.mcodeSessionId,
    requestId: `request-${scope.threadId}-${sequence}`,
    sequence,
    deadline: 50_000,
    expectedControlEpoch: 0,
    operation: "status",
    args: {},
  };
}

function statusResult() {
  return {
    operation: "status" as const,
    available: true,
    active: true,
    url: "https://example.test/",
    loading: false,
    focused: true,
    viewport: { width: 1280, height: 720 },
    capabilities: ["status" as const],
  };
}

describe("BrowserAutomationBroker", () => {
  it("never cross-routes two threads across workspace-scoped hosts", async () => {
    const deliveries: Array<{ socket: WebSocket; data: any }> = [];
    const broker = new BrowserAutomationBroker(options({ now: () => 10, send: (target, channel, data) => {
      if (channel === "browserAutomation.request") deliveries.push({ socket: target, data });
      return true;
    } }));
    const firstSocket = socket("first");
    const secondSocket = socket("second");
    const firstGeneration = register(broker, firstSocket, "first", "workspace-a");
    const secondGeneration = register(broker, secondSocket, "second", "workspace-b");
    updateTargets(broker, firstSocket, "first", firstGeneration, ["thread-a"]);
    updateTargets(broker, secondSocket, "second", secondGeneration, ["thread-b"]);
    const a = claims("thread-a", "workspace-a");
    const b = claims("thread-b", "workspace-b");

    const firstPending = broker.execute(a, request(a));
    const secondPending = broker.execute(b, request(b));
    expect(deliveries.map((delivery) => delivery.socket)).toEqual([firstSocket, secondSocket]);
    for (const delivery of deliveries) {
      const hostId = delivery.data.hostId;
      const target = hostId === "first" ? firstSocket : secondSocket;
      broker.respond(target, hostId, delivery.data.generation, {
        contractVersion: 1,
        requestId: delivery.data.dispatch.request.requestId,
        sequence: delivery.data.dispatch.request.sequence,
        ok: true,
        result: statusResult(),
      });
    }
    await expect(firstPending).resolves.toMatchObject({ ok: true });
    await expect(secondPending).resolves.toMatchObject({ ok: true });
  });

  it("preserves a web host CROSS_ORIGIN response across the broker boundary", async () => {
    const deliveries: any[] = [];
    const broker = new BrowserAutomationBroker(options({
      now: () => 10,
      send: (_socket, channel, data) => {
        if (channel === "browserAutomation.request") deliveries.push(data);
        return true;
      },
    }));
    const hostSocket = socket("web");
    const generation = broker.registerHost(hostSocket, {
      ...registration("web", "workspace-a"),
      runtime: "web",
      targetIdentity: {
        worktreeIdentity: "worktree-a",
        connectionId: "desktop-web",
        workspaceId: "workspace-a",
        threadId: "thread-a",
        tabId: "tab-thread-a",
        generation: 1,
      },
      capabilities: [{ operation: "snapshot", available: true }],
    }, {
      ...authorization("web"),
      allowWebRuntime: true,
    }).generation;
    updateTargets(broker, hostSocket, "web", generation, ["thread-a"]);
    const scope = {
      ...claims("thread-a", "workspace-a"),
      allowedOperations: ["snapshot" as const],
    };
    const pending = broker.execute(scope, {
      ...request(scope),
      operation: "snapshot",
      args: { includeScreenshot: false, timeoutMs: 1_000 },
    });
    const delivery = deliveries[0]!;
    const crossOrigin = {
      contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
      requestId: delivery.dispatch.request.requestId,
      sequence: delivery.dispatch.request.sequence,
      ok: false as const,
      error: {
        code: "CROSS_ORIGIN" as const,
        message: "Visible preview is cross-origin",
        retryable: false,
      },
    };
    broker.respond(hostSocket, "web", generation, crossOrigin);
    await expect(pending).resolves.toEqual(crossOrigin);
  });

  it("keeps externally supplied identifiers collision-proof", async () => {
    const deliveries: any[] = [];
    const broker = new BrowserAutomationBroker(options({
      now: () => 10,
      send: (_socket, channel, data) => {
        if (channel === "browserAutomation.request") deliveries.push(data);
        return true;
      },
    }));
    const hostSocket = socket("first");
    const generation = register(broker, hostSocket, "first", "workspace-a");
    updateTargets(broker, hostSocket, "first", generation, ["thread\u0000a", "thread"]);
    const first = {
      ...claims("thread\u0000a", "workspace-a"),
      providerSessionId: "session",
    };
    const second = {
      ...claims("thread", "workspace-a"),
      providerSessionId: "session\u0000thread\u0000a",
    };

    const firstPending = broker.execute(first, request(first));
    const secondPending = broker.execute(second, request(second));
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0].dispatch.target.threadId).toBe("thread\u0000a");
    expect(deliveries[1].dispatch.target.threadId).toBe("thread");
    broker.disconnect(hostSocket);
    await Promise.all([firstPending, secondPending]);
  });

  it("keeps a provider session sticky and ignores late responses after timeout", async () => {
    vi.useFakeTimers();
    const deliveries: any[] = [];
    let now = 10;
    const broker = new BrowserAutomationBroker(options({ now: () => now, send: (_target, channel, data) => {
      deliveries.push({ channel, data });
      if (channel === "browserAutomation.cancel") throw new Error("cancel delivery failed");
      return true;
    } }));
    const firstSocket = socket("first");
    const secondSocket = socket("second");
    const firstGeneration = register(broker, firstSocket, "first", "workspace-a");
    const secondGeneration = register(broker, secondSocket, "second", "workspace-a");
    updateTargets(broker, firstSocket, "first", firstGeneration, ["thread-a"]);
    updateTargets(broker, secondSocket, "second", secondGeneration, ["thread-a"]);
    const scope = claims("thread-a", "workspace-a");
    const pending = broker.execute(scope, { ...request(scope), deadline: 20 });
    now = 21;
    await vi.advanceTimersByTimeAsync(10);
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "DEADLINE_EXCEEDED" } });
    expect(deliveries[0].data.hostId).toBe("first");
    broker.respond(firstSocket, "first", firstGeneration, {
      contractVersion: 1,
      requestId: request(scope).requestId,
      sequence: 1,
      ok: true,
      result: statusResult(),
    });
    expect(broker.status().pending).toBe(0);
    const secondPending = broker.execute(scope, { ...request(scope, 2), deadline: 100 });
    expect(deliveries.at(-1)?.data.hostId).toBe("first");
    broker.disconnect(firstSocket);
    await expect(secondPending).resolves.toMatchObject({ ok: false, error: { code: "HOST_UNAVAILABLE" } });
    vi.useRealTimers();
  });

  it("settles pending work and clears sticky assignments on disconnect", async () => {
    const broker = new BrowserAutomationBroker(options({ now: () => 10, send: () => true }));
    const hostSocket = socket("first");
    const generation = register(broker, hostSocket, "first", "workspace-a");
    updateTargets(broker, hostSocket, "first", generation, ["thread-a"]);
    const scope = claims("thread-a", "workspace-a");
    const pending = broker.execute(scope, request(scope));
    broker.disconnect(hostSocket);
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "HOST_UNAVAILABLE" } });
    expect(broker.status()).toEqual({ hosts: 0, pending: 0, assignments: 0 });
  });

  it("enforces request scope and global capacity", async () => {
    const broker = new BrowserAutomationBroker(options({ now: () => 10, maxPendingRequests: 1, send: () => true }));
    const hostSocket = socket("first");
    const generation = register(broker, hostSocket, "first", "workspace-a");
    updateTargets(broker, hostSocket, "first", generation, ["thread-a"]);
    const scope = claims("thread-a", "workspace-a");
    await expect(broker.execute(scope, { ...request(scope), threadId: "thread-b" })).resolves.toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    const pending = broker.execute(scope, request(scope));
    await expect(broker.execute(scope, request(scope, 2))).resolves.toMatchObject({ ok: false, error: { code: "HOST_UNAVAILABLE" } });
    broker.disconnect(hostSocket);
    await pending;
  });

  it("rejects an impostor before it can replace an authorized host", async () => {
    const deliveries: any[] = [];
    const broker = new BrowserAutomationBroker(options({ now: () => 10, send: (_socket, channel, data) => {
      if (channel === "browserAutomation.request") deliveries.push(data);
      return true;
    } }));
    const authorized = socket("first");
    const generation = register(broker, authorized, "first", "workspace-a");
    updateTargets(broker, authorized, "first", generation, ["thread-a"]);
    expect(() => broker.registerHost(
      socket("attacker"),
      registration("first", "workspace-a"),
      authorization("attacker"),
    )).toThrow("already registered");

    const scope = claims("thread-a", "workspace-a");
    const pending = broker.execute(scope, request(scope));
    expect(deliveries).toHaveLength(1);
    broker.disconnect(authorized);
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "HOST_UNAVAILABLE" } });
  });

  it("replaces a reconnecting owner deterministically and cancels its old work", async () => {
    const broker = new BrowserAutomationBroker(options({ now: () => 10, send: () => true }));
    const firstSocket = socket("first");
    const firstGeneration = register(broker, firstSocket, "first", "workspace-a");
    updateTargets(broker, firstSocket, "first", firstGeneration, ["thread-a"]);
    const scope = claims("thread-a", "workspace-a");
    const pending = broker.execute(scope, request(scope));

    const replacementSocket = socket("replacement");
    const replacementGeneration = broker.registerHost(
      replacementSocket,
      registration("first", "workspace-a"),
      authorization("first"),
    ).generation;

    await expect(pending).resolves.toMatchObject({ error: { code: "HOST_UNAVAILABLE" } });
    expect(broker.status()).toEqual({ hosts: 1, pending: 0, assignments: 0 });
    expect(() => broker.heartbeat(firstSocket, "first", firstGeneration)).toThrow("stale or invalid");
    updateTargets(broker, replacementSocket, "first", replacementGeneration, ["thread-a"]);
  });

  it("settles all pending work during broker shutdown", async () => {
    const broker = new BrowserAutomationBroker(options({ now: () => 10, send: () => true }));
    const hostSocket = socket("first");
    const generation = register(broker, hostSocket, "first", "workspace-a");
    updateTargets(broker, hostSocket, "first", generation, ["thread-a"]);
    const scope = claims("thread-a", "workspace-a");
    const pending = broker.execute(scope, request(scope));

    broker.shutdown();

    await expect(pending).resolves.toMatchObject({ error: { code: "HOST_UNAVAILABLE" } });
    expect(broker.status()).toEqual({ hosts: 0, pending: 0, assignments: 0 });
  });

  it("requires trusted targets and rejects self-asserted workspace or stale target generations", async () => {
    const broker = new BrowserAutomationBroker(options({ now: () => 10, send: () => true }));
    const hostSocket = socket("first");
    expect(() => broker.registerHost(
      hostSocket,
      registration("first", "workspace-b"),
      authorization("first", ["workspace-a"]),
    )).toThrow("not authorized");

    const generation = register(broker, hostSocket, "first", "workspace-a");
    const scope = claims("thread-a", "workspace-a");
    await expect(broker.execute(scope, request(scope))).resolves.toMatchObject({
      ok: false,
      error: { code: "TAB_UNAVAILABLE" },
    });
    expect(() => updateTargets(broker, hostSocket, "first", generation + 1, ["thread-a"])).toThrow("stale or invalid");
    expect(() => broker.updateTargets(hostSocket, "first", generation, [{
      desktopInstanceId: "desktop-first",
      windowId: 1,
      connectionGeneration: generation + 1,
      threadId: "thread-a",
      tabId: "tab-thread-a",
      targetGeneration: 0,
      active: true,
      focused: true,
      lastUsedAt: 10,
    }])).toThrow("identity does not match");
  });

  it("fails pending work when its exact target is removed", async () => {
    let delivery: any;
    const broker = new BrowserAutomationBroker(options({ now: () => 10, send: (_socket, channel, data) => {
      if (channel === "browserAutomation.request") delivery = data;
      return true;
    } }));
    const hostSocket = socket("first");
    const generation = register(broker, hostSocket, "first", "workspace-a");
    updateTargets(broker, hostSocket, "first", generation, ["thread-a"]);
    const scope = claims("thread-a", "workspace-a");
    const pending = broker.execute(scope, request(scope));
    expect(BrowserAutomationHostDispatchSchema().safeParse(delivery.dispatch).success).toBe(true);
    broker.updateTargets(hostSocket, "first", generation, []);
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "TAB_UNAVAILABLE" } });
    expect(broker.status().pending).toBe(0);
  });

  it("preserves an assigned open across an exact target generation transition", async () => {
    const deliveries: any[] = [];
    const broker = new BrowserAutomationBroker(options({
      now: () => 10,
      send: (_socket, channel, data) => {
        if (channel === "browserAutomation.request") deliveries.push(data);
        return true;
      },
    }));
    const hostSocket = socket("first");
    const generation = broker.registerHost(hostSocket, {
      ...registration("first", "workspace-a"),
      capabilities: [
        { operation: "open", available: true },
        { operation: "status", available: true },
      ],
    }, authorization("first")).generation;
    const target = {
      desktopInstanceId: "desktop-first",
      windowId: 1,
      connectionGeneration: generation,
      threadId: "thread-a",
      tabId: "tab-thread-a",
      targetGeneration: 0,
      active: true,
      focused: true,
      lastUsedAt: 10,
    };
    broker.updateTargets(hostSocket, "first", generation, [target]);
    const scope = {
      ...claims("thread-a", "workspace-a"),
      allowedOperations: ["open" as const, "status" as const],
    };
    const opened = broker.execute(scope, {
      ...request(scope),
      operation: "open",
      args: { url: "https://example.test/" },
    });
    const replacement = { ...target, targetGeneration: 1, lastUsedAt: 11 };
    broker.updateTargets(hostSocket, "first", generation, [replacement]);
    expect(broker.status().pending).toBe(1);

    broker.respond(hostSocket, "first", generation, {
      contractVersion: 1,
      requestId: deliveries[0].dispatch.request.requestId,
      sequence: deliveries[0].dispatch.request.sequence,
      ok: true,
      result: { operation: "open", url: "https://example.test/", title: "Example", controlEpoch: 0 },
    });
    await expect(opened).resolves.toMatchObject({ ok: true });

    const status = broker.execute(scope, request(scope, 2));
    expect(deliveries[1].dispatch.target).toMatchObject({ targetGeneration: 1 });
    broker.respond(hostSocket, "first", generation, {
      contractVersion: 1,
      requestId: deliveries[1].dispatch.request.requestId,
      sequence: deliveries[1].dispatch.request.sequence,
      ok: true,
      result: statusResult(),
    });
    await expect(status).resolves.toMatchObject({ ok: true });
  });

  it("preserves an assigned navigate across an exact target generation transition", async () => {
    let delivery: any;
    const broker = new BrowserAutomationBroker(options({
      now: () => 10,
      send: (_socket, channel, data) => {
        if (channel === "browserAutomation.request") delivery = data;
        return true;
      },
    }));
    const hostSocket = socket("first");
    const generation = broker.registerHost(hostSocket, {
      ...registration("first", "workspace-a"),
      capabilities: [
        { operation: "navigate", available: true },
        { operation: "status", available: true },
      ],
    }, authorization("first")).generation;
    const target = {
      desktopInstanceId: "desktop-first",
      windowId: 1,
      connectionGeneration: generation,
      threadId: "thread-a",
      tabId: "tab-thread-a",
      targetGeneration: 0,
      active: true,
      focused: true,
      lastUsedAt: 10,
    };
    broker.updateTargets(hostSocket, "first", generation, [target]);
    const scope = {
      ...claims("thread-a", "workspace-a"),
      allowedOperations: ["navigate" as const, "status" as const],
    };
    const navigated = broker.execute(scope, {
      ...request(scope),
      operation: "navigate",
      args: { url: "https://example.test/destination" },
    });
    broker.updateTargets(hostSocket, "first", generation, [{ ...target, targetGeneration: 1 }]);
    expect(broker.status().pending).toBe(1);

    broker.respond(hostSocket, "first", generation, {
      contractVersion: 1,
      requestId: delivery.dispatch.request.requestId,
      sequence: delivery.dispatch.request.sequence,
      ok: true,
      result: {
        operation: "navigate",
        url: "https://example.test/destination",
        title: "Destination",
        controlEpoch: 1,
      },
    });
    await expect(navigated).resolves.toMatchObject({ ok: true });
  });

  it("settles non-open work when an assigned target advances generations", async () => {
    let delivery: any;
    const broker = new BrowserAutomationBroker(options({
      now: () => 10,
      send: (_socket, channel, data) => {
        if (channel === "browserAutomation.request") delivery = data;
        return true;
      },
    }));
    const hostSocket = socket("first");
    const generation = register(broker, hostSocket, "first", "workspace-a");
    updateTargets(broker, hostSocket, "first", generation, ["thread-a"]);
    const scope = claims("thread-a", "workspace-a");
    const pending = broker.execute(scope, request(scope));
    broker.updateTargets(hostSocket, "first", generation, [{
      ...delivery.dispatch.target,
      targetGeneration: delivery.dispatch.target.targetGeneration + 1,
    }]);
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "TAB_UNAVAILABLE" } });
  });

  it("settles open work for generation jumps and window changes", async () => {
    const run = async (replacement: (target: any) => any) => {
      const broker = new BrowserAutomationBroker(options({
        now: () => 10,
        send: () => true,
      }));
      const hostSocket = socket("first");
      const generation = broker.registerHost(hostSocket, {
        ...registration("first", "workspace-a"),
        capabilities: [{ operation: "open", available: true }],
      }, authorization("first")).generation;
      const target = {
        desktopInstanceId: "desktop-first",
        windowId: 1,
        connectionGeneration: generation,
        threadId: "thread-a",
        tabId: "tab-thread-a",
        targetGeneration: 0,
        active: true,
        focused: true,
        lastUsedAt: 10,
      };
      broker.updateTargets(hostSocket, "first", generation, [target]);
      const scope = { ...claims("thread-a", "workspace-a"), allowedOperations: ["open" as const] };
      const pending = broker.execute(scope, {
        ...request(scope),
        operation: "open",
        args: { url: "https://example.test/" },
      });
      broker.updateTargets(hostSocket, "first", generation, [replacement(target)]);
      await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "TAB_UNAVAILABLE" } });
    };
    await run((target) => ({ ...target, targetGeneration: 2 }));
    await run((target) => ({ ...target, windowId: 2, targetGeneration: 1 }));
  });

  it("settles and decrements when directed delivery throws synchronously", async () => {
    const broker = new BrowserAutomationBroker(options({ now: () => 10, send: () => { throw new Error("socket failed"); } }));
    const hostSocket = socket("first");
    const generation = register(broker, hostSocket, "first", "workspace-a");
    updateTargets(broker, hostSocket, "first", generation, ["thread-a"]);
    const scope = claims("thread-a", "workspace-a");
    await expect(broker.execute(scope, request(scope))).resolves.toMatchObject({ ok: false, error: { code: "HOST_UNAVAILABLE" } });
    expect(broker.status().pending).toBe(0);
  });

  it("expires missed heartbeats and settles pending work", async () => {
    let now = 10;
    const broker = new BrowserAutomationBroker(options({ now: () => now, hostHeartbeatTimeoutMs: 1_000, send: () => true }));
    const hostSocket = socket("first");
    const generation = register(broker, hostSocket, "first", "workspace-a");
    updateTargets(broker, hostSocket, "first", generation, ["thread-a"]);
    const scope = claims("thread-a", "workspace-a");
    const pending = broker.execute(scope, request(scope));
    now = 1_011;
    broker.sweep();
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "HOST_UNAVAILABLE" } });
    expect(broker.status()).toEqual({ hosts: 0, pending: 0, assignments: 0 });
  });

  it("rejects a success response for a different operation", async () => {
    let delivery: any;
    const broker = new BrowserAutomationBroker(options({ now: () => 10, send: (_socket, channel, data) => {
      if (channel === "browserAutomation.request") delivery = data;
      return true;
    } }));
    const hostSocket = socket("first");
    const generation = register(broker, hostSocket, "first", "workspace-a");
    updateTargets(broker, hostSocket, "first", generation, ["thread-a"]);
    const scope = claims("thread-a", "workspace-a");
    const pending = broker.execute(scope, request(scope));
    broker.respond(hostSocket, "first", generation, {
      contractVersion: 1,
      requestId: delivery.dispatch.request.requestId,
      sequence: delivery.dispatch.request.sequence,
      ok: true,
      result: { operation: "open", url: "https://example.com/", title: "Example", controlEpoch: 0 },
    });
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  });

  it("bounds sticky assignments and exposes provider-session cleanup", async () => {
    const deliveries: any[] = [];
    const broker = new BrowserAutomationBroker(options({ now: () => 10, maxAssignments: 2, send: (_socket, channel, data) => {
      if (channel === "browserAutomation.request") deliveries.push(data);
      return true;
    } }));
    const hostSocket = socket("first");
    const generation = register(broker, hostSocket, "first", "workspace-a");
    updateTargets(broker, hostSocket, "first", generation, ["thread-0", "thread-1", "thread-2"]);
    for (let index = 0; index < 3; index++) {
      const scope = claims(`thread-${index}`, "workspace-a");
      const pending = broker.execute(scope, request(scope));
      const delivery = deliveries.at(-1);
      broker.respond(hostSocket, "first", generation, {
        contractVersion: 1,
        requestId: delivery.dispatch.request.requestId,
        sequence: delivery.dispatch.request.sequence,
        ok: true,
        result: statusResult(),
      });
      await pending;
    }
    expect(broker.status().assignments).toBe(2);
    expect(broker.releaseProviderSession("cursor", "provider-thread-2")).toBe(1);
  });

  it("bounds hosts and targets and rejects target-generation rollback", () => {
    const broker = new BrowserAutomationBroker(options({
      now: () => 10,
      maxHosts: 1,
      maxTargets: 1,
      send: () => true,
    }));
    const first = socket("first");
    const generation = register(broker, first, "first", "workspace-a");
    expect(() => register(broker, socket("second"), "second", "workspace-a"))
      .toThrow("host capacity");
    expect(() => updateTargets(
      broker,
      first,
      "first",
      generation,
      ["thread-a", "thread-b"],
    )).toThrow("target capacity");

    broker.updateTargets(first, "first", generation, [{
      desktopInstanceId: "desktop-first",
      windowId: 1,
      connectionGeneration: generation,
      threadId: "thread-a",
      tabId: "tab-thread-a",
      targetGeneration: 2,
      active: true,
      focused: false,
      lastUsedAt: 10,
    }]);
    broker.updateTargets(first, "first", generation, []);
    expect(() => broker.updateTargets(first, "first", generation, [{
      desktopInstanceId: "desktop-first",
      windowId: 1,
      connectionGeneration: generation,
      threadId: "thread-a",
      tabId: "tab-thread-a",
      targetGeneration: 1,
      active: true,
      focused: false,
      lastUsedAt: 11,
    }])).toThrow("generation is stale");
  });

  it("cancels pending work and assignments when its provider session is revoked", async () => {
    const deliveries: Array<{ channel: string; data: any }> = [];
    const broker = new BrowserAutomationBroker(options({
      now: () => 10,
      send: (_socket, channel, data) => {
        deliveries.push({ channel, data });
        return true;
      },
    }));
    const hostSocket = socket("first");
    const generation = register(broker, hostSocket, "first", "workspace-a");
    updateTargets(broker, hostSocket, "first", generation, ["thread-a"]);
    const scope = claims("thread-a", "workspace-a");
    const pending = broker.execute(scope, request(scope));

    expect(broker.releaseProviderSession(scope.providerId, scope.providerSessionId)).toBe(1);
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "OPERATION_CANCELLED" },
    });
    expect(deliveries.some((delivery) => delivery.channel === "browserAutomation.cancel")).toBe(true);
    expect(broker.status()).toMatchObject({ pending: 0, assignments: 0 });
  });

  it("distinguishes user cancellation from host loss in errors and reliability", async () => {
    const broker = new BrowserAutomationBroker(options({ now: () => 10, send: () => true }));
    const hostSocket = socket("first");
    const generation = register(broker, hostSocket, "first", "workspace-a");
    updateTargets(broker, hostSocket, "first", generation, ["thread-a"]);
    const scope = claims("thread-a", "workspace-a");

    const stopped = broker.execute(scope, request(scope));
    broker.cancelFromHost(hostSocket, "first", generation, request(scope).requestId, 1, "user-stopped");
    await expect(stopped).resolves.toMatchObject({
      ok: false,
      error: { code: "OPERATION_CANCELLED", retryable: false },
    });

    const shutdown = broker.execute(scope, request(scope, 2));
    broker.cancelFromHost(hostSocket, "first", generation, request(scope, 2).requestId, 2, "host-shutdown");
    await expect(shutdown).resolves.toMatchObject({
      ok: false,
      error: { code: "HOST_UNAVAILABLE", retryable: true },
    });
    expect(broker.reliabilityStatus()).toMatchObject({ interrupted: 1, hostLosses: 1 });
  });

  it("reports bounded content-free reliability counters", async () => {
    let now = 10;
    let delivery: any;
    const broker = new BrowserAutomationBroker(options({
      now: () => now,
      maxPendingRequests: 1,
      send: (_socket, channel, data) => {
        if (channel === "browserAutomation.request") delivery = data;
        return true;
      },
    }));
    const hostSocket = socket("first");
    const generation = register(broker, hostSocket, "first", "workspace-a");
    updateTargets(broker, hostSocket, "first", generation, ["thread-a"]);
    const scope = claims("thread-a", "workspace-a");
    const completed = broker.execute(scope, request(scope));
    await expect(broker.execute(scope, request(scope, 2))).resolves.toMatchObject({
      ok: false,
      error: { code: "HOST_UNAVAILABLE" },
    });
    now = 35;
    broker.respond(hostSocket, "first", generation, {
      contractVersion: 1,
      requestId: delivery.dispatch.request.requestId,
      sequence: delivery.dispatch.request.sequence,
      ok: true,
      result: statusResult(),
    });
    await completed;

    expect(broker.reliabilityStatus()).toEqual({
      dispatched: 2,
      succeeded: 1,
      failed: 1,
      timedOut: 0,
      interrupted: 0,
      truncated: 0,
      hostLosses: 1,
      capacityRejected: 1,
      latencyTotalMs: 25,
      latencyMaxMs: 25,
    });
    expect(JSON.stringify(broker.reliabilityStatus())).not.toContain("thread-a");
  });

  it("counts truncation nested inside screenshot and snapshot results", async () => {
    const deliveries: any[] = [];
    const broker = new BrowserAutomationBroker(options({
      now: () => 10,
      send: (_socket, channel, data) => {
        if (channel === "browserAutomation.request") deliveries.push(data);
        return true;
      },
    }));
    const hostSocket = socket("diagnostics");
    const generation = broker.registerHost(hostSocket, {
      ...registration("diagnostics", "workspace-a"),
      capabilities: [
        { operation: "screenshot", available: true },
        { operation: "snapshot", available: true },
      ],
    }, authorization("diagnostics")).generation;
    updateTargets(broker, hostSocket, "diagnostics", generation, ["thread-a"]);
    const scope = {
      ...claims("thread-a", "workspace-a"),
      allowedOperations: ["screenshot" as const, "snapshot" as const],
    };
    const screenshotPending = broker.execute(scope, {
      ...request(scope),
      operation: "screenshot",
      args: { maxWidth: 100, fullPage: false },
    });
    broker.respond(hostSocket, "diagnostics", generation, {
      contractVersion: 1,
      requestId: deliveries[0].dispatch.request.requestId,
      sequence: 1,
      ok: true,
      result: {
        operation: "screenshot",
        screenshot: {
          mediaType: "image/png",
          dataBase64: "",
          width: 100,
          height: 50,
          truncation: { truncated: true, originalCount: 200, reason: "byte-limit" },
        },
        controlEpoch: 0,
      },
    });
    await screenshotPending;

    const snapshotPending = broker.execute(scope, {
      ...request(scope, 2),
      operation: "snapshot",
      args: { includeScreenshot: false, timeoutMs: 1_000 },
    });
    broker.respond(hostSocket, "diagnostics", generation, {
      contractVersion: 1,
      requestId: deliveries[1].dispatch.request.requestId,
      sequence: 2,
      ok: true,
      result: {
        operation: "snapshot",
        snapshot: {
          url: "https://example.test/",
          title: "Example",
          loading: false,
          visibleText: "x",
          visibleTextTruncation: { truncated: true, originalCount: 2, reason: "character-limit" },
          elements: [],
          elementsTruncation: { truncated: false, originalCount: 0 },
          accessibility: [],
          accessibilityTruncation: { truncated: false, originalCount: 0 },
          console: [],
          consoleTruncation: { truncated: false, originalCount: 0 },
          network: [],
          networkTruncation: { truncated: false, originalCount: 0 },
          actions: [],
          actionsTruncation: { truncated: false, originalCount: 0 },
        },
        controlEpoch: 0,
      },
    });
    await snapshotPending;

    expect(broker.reliabilityStatus()).toMatchObject({ succeeded: 2, truncated: 2 });
  });

  it("cancels targetless bootstrap work on deadline", async () => {
    vi.useFakeTimers();
    const deliveries: Array<{ channel: string; data: any }> = [];
    let now = 10;
    const broker = new BrowserAutomationBroker(options({
      now: () => now,
      send: (_socket, channel, data) => {
        deliveries.push({ channel, data });
        return true;
      },
    }));
    const hostSocket = socket("bootstrap");
    broker.registerHost(hostSocket, {
      ...registration("bootstrap", "workspace-a"),
      capabilities: [{ operation: "open", available: true }],
    }, authorization("bootstrap"));
    const scope = {
      ...claims("thread-a", "workspace-a"),
      allowedOperations: ["open" as const],
    };
    const pending = broker.execute(scope, {
      ...request(scope),
      deadline: 20,
      operation: "open",
      args: { url: "https://example.test/" },
    });
    now = 21;
    await vi.advanceTimersByTimeAsync(10);

    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "DEADLINE_EXCEEDED" } });
    expect(deliveries).toEqual([
      expect.objectContaining({ channel: "browserAutomation.bootstrap" }),
      expect.objectContaining({
        channel: "browserAutomation.cancel",
        data: expect.objectContaining({ requestId: "request-thread-a-1", sequence: 1, reason: "deadline-exceeded" }),
      }),
    ]);
    expect(deliveries[1]?.data).not.toHaveProperty("target");
    vi.useRealTimers();
  });

  it("cancels targetless bootstrap work when its provider session is revoked", async () => {
    const deliveries: Array<{ channel: string; data: any }> = [];
    const broker = new BrowserAutomationBroker(options({
      now: () => 10,
      send: (_socket, channel, data) => {
        deliveries.push({ channel, data });
        return true;
      },
    }));
    const hostSocket = socket("bootstrap");
    broker.registerHost(hostSocket, {
      ...registration("bootstrap", "workspace-a"),
      capabilities: [{ operation: "open", available: true }],
    }, authorization("bootstrap"));
    const scope = {
      ...claims("thread-a", "workspace-a"),
      allowedOperations: ["open" as const],
    };
    const pending = broker.execute(scope, {
      ...request(scope),
      operation: "open",
      args: { url: "https://example.test/" },
    });

    broker.releaseProviderSession(scope.providerId, scope.providerSessionId);
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "OPERATION_CANCELLED" } });
    const cancel = deliveries.find((delivery) => delivery.channel === "browserAutomation.cancel");
    expect(cancel?.data).toMatchObject({
      requestId: "request-thread-a-1",
      sequence: 1,
      reason: "client-disconnected",
    });
    expect(cancel?.data).not.toHaveProperty("target");
  });

  it("atomically binds a successful bootstrap to its exact created target", async () => {
    const deliveries: Array<{ socket: WebSocket; channel: string; data: any }> = [];
    const broker = new BrowserAutomationBroker(options({
      now: () => 10,
      send: (targetSocket, channel, data) => {
        deliveries.push({ socket: targetSocket, channel, data });
        return true;
      },
    }));
    const bootstrapSocket = socket("bootstrap");
    const olderSocket = socket("older");
    const bootstrapGeneration = broker.registerHost(bootstrapSocket, {
      ...registration("bootstrap", "workspace-a"),
      capabilities: [
        { operation: "open", available: true },
        { operation: "status", available: true },
      ],
    }, authorization("bootstrap")).generation;
    const olderGeneration = register(broker, olderSocket, "older", "workspace-a");
    updateTargets(broker, olderSocket, "older", olderGeneration, ["thread-a"]);
    const scope = {
      ...claims("thread-a", "workspace-a"),
      allowedOperations: ["open" as const, "status" as const],
    };
    const opened = broker.execute(scope, {
      ...request(scope),
      operation: "open",
      args: { url: "https://example.test/" },
    });
    const bootstrap = deliveries.find((delivery) => delivery.channel === "browserAutomation.bootstrap")!;
    const createdTarget = {
      desktopInstanceId: "desktop-bootstrap",
      windowId: 7,
      connectionGeneration: bootstrapGeneration,
      threadId: "thread-a",
      tabId: "newly-created-tab",
      targetGeneration: 3,
      active: true,
      focused: true,
      lastUsedAt: 20,
    };
    broker.respond(bootstrapSocket, "bootstrap", bootstrapGeneration, {
      contractVersion: 1,
      requestId: bootstrap.data.request.requestId,
      sequence: bootstrap.data.request.sequence,
      ok: true,
      result: {
        operation: "open",
        url: "https://example.test/",
        title: "Example",
        controlEpoch: 0,
      },
    }, createdTarget);
    await expect(opened).resolves.toMatchObject({ ok: true });

    const status = broker.execute(scope, request(scope, 2));
    const statusDelivery = deliveries.find((delivery) =>
      delivery.channel === "browserAutomation.request" && delivery.data.dispatch.request.sequence === 2,
    )!;
    expect(statusDelivery.socket).toBe(bootstrapSocket);
    expect(statusDelivery.data.dispatch.target).toEqual(createdTarget);
    broker.respond(bootstrapSocket, "bootstrap", bootstrapGeneration, {
      contractVersion: 1,
      requestId: statusDelivery.data.dispatch.request.requestId,
      sequence: 2,
      ok: true,
      result: statusResult(),
    });
    await expect(status).resolves.toMatchObject({ ok: true });
  });

  it("selects focused, then active, then most recently used matching targets", async () => {
    const deliveries: Array<{ socket: WebSocket; data: any }> = [];
    const broker = new BrowserAutomationBroker(options({
      now: () => 500,
      send: (targetSocket, channel, data) => {
        if (channel === "browserAutomation.request") deliveries.push({ socket: targetSocket, data });
        return true;
      },
    }));
    const firstSocket = socket("first");
    const secondSocket = socket("second");
    const firstGeneration = register(broker, firstSocket, "first", "workspace-a");
    const secondGeneration = register(broker, secondSocket, "second", "workspace-a");
    const advertise = (
      targetSocket: WebSocket,
      hostId: string,
      generation: number,
      metadata: { active: boolean; focused: boolean; lastUsedAt: number },
    ) => broker.updateTargets(targetSocket, hostId, generation, [{
      desktopInstanceId: `desktop-${hostId}`,
      windowId: generation,
      connectionGeneration: generation,
      threadId: "thread-a",
      tabId: `tab-${hostId}`,
      targetGeneration: 0,
      ...metadata,
    }]);
    const executeAndSettle = async (session: string): Promise<WebSocket> => {
      const scope = {
        ...claims("thread-a", "workspace-a"),
        providerSessionId: session,
        mcodeSessionId: `mcode-${session}`,
      };
      const pending = broker.execute(scope, request(scope));
      const delivery = deliveries.at(-1)!;
      const hostId = delivery.socket === firstSocket ? "first" : "second";
      const generation = delivery.socket === firstSocket ? firstGeneration : secondGeneration;
      broker.respond(delivery.socket, hostId, generation, {
        contractVersion: 1,
        requestId: delivery.data.dispatch.request.requestId,
        sequence: delivery.data.dispatch.request.sequence,
        ok: true,
        result: statusResult(),
      });
      await pending;
      return delivery.socket;
    };

    advertise(firstSocket, "first", firstGeneration, { focused: true, active: false, lastUsedAt: 1 });
    advertise(secondSocket, "second", secondGeneration, { focused: false, active: true, lastUsedAt: 100 });
    await expect(executeAndSettle("focused-session")).resolves.toBe(firstSocket);

    advertise(firstSocket, "first", firstGeneration, { focused: false, active: false, lastUsedAt: 200 });
    advertise(secondSocket, "second", secondGeneration, { focused: false, active: true, lastUsedAt: 100 });
    await expect(executeAndSettle("active-session")).resolves.toBe(secondSocket);

    advertise(firstSocket, "first", firstGeneration, { focused: false, active: false, lastUsedAt: 200 });
    advertise(secondSocket, "second", secondGeneration, { focused: false, active: false, lastUsedAt: 100 });
    await expect(executeAndSettle("recent-session")).resolves.toBe(firstSocket);
  });

  it("never reroutes a sticky session for capability mismatch or temporary capacity", async () => {
    const deliveries: Array<{ socket: WebSocket; data: any }> = [];
    const broker = new BrowserAutomationBroker(options({
      now: () => 10,
      send: (targetSocket, channel, data) => {
        if (channel === "browserAutomation.request") deliveries.push({ socket: targetSocket, data });
        return true;
      },
    }));
    const assignedSocket = socket("assigned");
    const alternateSocket = socket("alternate");
    const assignedGeneration = broker.registerHost(assignedSocket, {
      ...registration("assigned", "workspace-a"),
      capabilities: [{ operation: "status", available: true }],
      maxPendingRequests: 1,
    }, authorization("assigned")).generation;
    const alternateGeneration = broker.registerHost(alternateSocket, {
      ...registration("alternate", "workspace-a"),
      capabilities: [
        { operation: "status", available: true },
        { operation: "recordingStart", available: true },
      ],
      maxPendingRequests: 1,
    }, authorization("alternate")).generation;
    broker.updateTargets(assignedSocket, "assigned", assignedGeneration, [{
      desktopInstanceId: "desktop-assigned",
      windowId: 1,
      connectionGeneration: assignedGeneration,
      threadId: "thread-a",
      tabId: "assigned-tab",
      targetGeneration: 0,
      active: true,
      focused: true,
      lastUsedAt: 100,
    }]);
    broker.updateTargets(alternateSocket, "alternate", alternateGeneration, [{
      desktopInstanceId: "desktop-alternate",
      windowId: 2,
      connectionGeneration: alternateGeneration,
      threadId: "thread-a",
      tabId: "alternate-tab",
      targetGeneration: 0,
      active: false,
      focused: false,
      lastUsedAt: 200,
    }]);
    const scope = {
      ...claims("thread-a", "workspace-a"),
      permissionCapability: "interact" as const,
      allowedOperations: ["status" as const, "recordingStart" as const],
    };
    const first = broker.execute(scope, request(scope));
    expect(deliveries[0]?.socket).toBe(assignedSocket);
    broker.respond(assignedSocket, "assigned", assignedGeneration, {
      contractVersion: 1,
      requestId: deliveries[0]!.data.dispatch.request.requestId,
      sequence: 1,
      ok: true,
      result: statusResult(),
    });
    await first;

    await expect(broker.execute(scope, {
      ...request(scope, 2),
      operation: "recordingStart",
      args: { maxDurationMs: 1_000 },
    })).resolves.toMatchObject({ ok: false, error: { code: "UNSUPPORTED_OPERATION" } });
    expect(deliveries).toHaveLength(1);

    const otherScope = {
      ...scope,
      providerSessionId: "other-provider-session",
      mcodeSessionId: "other-mcode-session",
    };
    const occupying = broker.execute(otherScope, request(otherScope, 99));
    expect(deliveries[1]?.socket).toBe(assignedSocket);
    await expect(broker.execute(scope, request(scope, 3))).resolves.toMatchObject({
      ok: false,
      error: { code: "HOST_UNAVAILABLE" },
    });
    expect(deliveries).toHaveLength(2);
    broker.disconnect(assignedSocket);
    await occupying;
  });

  it("rejects successful bootstrap responses without an exact target", async () => {
    let bootstrap: any;
    const broker = new BrowserAutomationBroker(options({
      now: () => 10,
      send: (_socket, channel, data) => {
        if (channel === "browserAutomation.bootstrap") bootstrap = data;
        return true;
      },
    }));
    const hostSocket = socket("bootstrap");
    const generation = broker.registerHost(hostSocket, {
      ...registration("bootstrap", "workspace-a"),
      capabilities: [{ operation: "open", available: true }],
    }, authorization("bootstrap")).generation;
    const scope = { ...claims("thread-a", "workspace-a"), allowedOperations: ["open" as const] };
    const pending = broker.execute(scope, {
      ...request(scope),
      operation: "open",
      args: { url: "https://example.test/" },
    });
    broker.respond(hostSocket, "bootstrap", generation, {
      contractVersion: 1,
      requestId: bootstrap.request.requestId,
      sequence: bootstrap.request.sequence,
      ok: true,
      result: { operation: "open", url: "https://example.test/", title: "Example", controlEpoch: 0 },
    });
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
  });
});
