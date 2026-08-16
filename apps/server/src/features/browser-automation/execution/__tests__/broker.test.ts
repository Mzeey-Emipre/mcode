import { describe, expect, it, vi } from "vitest";
import {
  BROWSER_AUTOMATION_CONTRACT_VERSION,
  BROWSER_AUTOMATION_OPERATIONS,
  BrowserAutomationHostDispatchSchema,
  type BrowserAutomationHostRegistration,
  type BrowserAutomationRequest,
} from "@mcode/contracts";
import type { WebSocket } from "ws";
import { BrowserAutomationBroker, type BrowserAutomationBrokerOptions } from "../broker.js";
import type { BrowserAutomationCredentialClaims } from "../../access/credential-registry.js";
import { BrowserAutomationTelemetry, type BrowserAutomationTelemetryEvent } from "../../observability/telemetry.js";

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
    executorDescriptor: {
      runtime: "electron",
      operations: [...BROWSER_AUTOMATION_OPERATIONS],
      constraints: { maxTabs: 32, maxSnapshotChars: 20_000, maxDiagnostics: 200 },
      capabilityRevision: 1,
    },
    capabilities: BROWSER_AUTOMATION_OPERATIONS.map((operation) => ({ operation, available: true })),
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
    allowedOperations: ["inspect"],
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
    operation: "inspect",
    args: {},
  };
}

function inspectResult() {
  return {
    operation: "inspect" as const,
    tabs: [],
    capabilities: ["inspect" as const],
  };
}

function browserTarget(hostId: string, generation: number, targetGeneration = 0, controller?: { tabId: string; controller: "none" | "human" | "agent"; controlEpoch: number }) {
  return {
    desktopInstanceId: `desktop-${hostId}`,
    windowId: 1,
    connectionGeneration: generation,
    threadId: "thread-a",
    tabId: "tab-thread-a",
    targetGeneration,
    active: true,
    focused: true,
    lastUsedAt: 1,
    ...(controller ? { controller } : {}),
  };
}

function pendingStatusWithMutation(mutation: (broker: BrowserAutomationBroker, socket: WebSocket, generation: number, scope: BrowserAutomationCredentialClaims) => void) {
  const deliveries: Array<{ channel: string; data: any }> = [];
  let armed = false;
  let nowCalls = 0;
  let broker!: BrowserAutomationBroker;
  const hostSocket = socket("drift-host");
  const optionsWithMutation = options({
    now: () => {
      nowCalls++;
      if (armed && nowCalls === 8) {
        armed = false;
        mutation(broker, hostSocket, generation, scope);
      }
      return 10;
    },
    send: (_target, channel, data) => {
      deliveries.push({ channel, data });
      return true;
    },
  });
  broker = new BrowserAutomationBroker(optionsWithMutation);
  const generation = broker.registerHost(hostSocket, registration("drift-host", "workspace-a"), authorization("drift-host")).generation;
  broker.updateTargets(hostSocket, "drift-host", generation, [browserTarget("drift-host", generation)]);
  const scope = claims("thread-a", "workspace-a");
  armed = true;
  const pending = broker.execute(scope, request(scope));
  return { broker, hostSocket, generation, pending, deliveries, scope };
}

describe("BrowserAutomationBroker", () => {
  it("rejects an explicitly mismatched executor descriptor runtime", () => {
    const broker = new BrowserAutomationBroker(options());
    expect(() => broker.registerHost(socket("mismatch"), {
      ...registration("mismatch", "workspace-a"),
      executorDescriptor: {
        runtime: "web",
        operations: ["inspect"],
        constraints: { maxTabs: 1, maxSnapshotChars: 100, maxDiagnostics: 1 },
        capabilityRevision: 1,
      },
    }, authorization("mismatch"))).toThrow("runtime does not match");
  });

  it("advertises bootstrap operations from a selected executor before a target exists", () => {
    const broker = new BrowserAutomationBroker(options());
    const hostSocket = socket("bootstrap-discovery");
    broker.registerHost(hostSocket, {
      ...registration("bootstrap-discovery", "workspace-a"),
      executorDescriptor: {
        ...registration("bootstrap-discovery", "workspace-a").executorDescriptor,
        operations: ["open", "evaluate"],
      },
      capabilities: [
        { operation: "open", available: true },
        { operation: "evaluate", available: true },
      ],
    }, authorization("bootstrap-discovery"));
    const scope = {
      ...claims("thread-a", "workspace-a"),
      permissionCapability: "privileged" as const,
      allowedOperations: ["open", "evaluate"] as const,
    };

    expect(broker.availableOperations(scope)).toEqual(["open", "evaluate"]);
    expect(broker.availableOperations({
      ...scope,
      permissionCapability: "interact",
    })).toEqual(["open"]);
  });

  it("never advertises evaluation through a web executor", () => {
    const broker = new BrowserAutomationBroker(options());
    broker.registerHost(socket("web-discovery"), {
      ...registration("web-discovery", "workspace-a"),
      runtime: "web",
      executorDescriptor: {
        ...registration("web-discovery", "workspace-a").executorDescriptor,
        runtime: "web",
        operations: ["open", "evaluate"],
      },
      capabilities: [
        { operation: "open", available: true },
        { operation: "evaluate", available: true },
      ],
    }, { ...authorization("web-discovery"), allowWebRuntime: true });
    const scope = {
      ...claims("thread-a", "workspace-a"),
      permissionCapability: "privileged" as const,
      allowedOperations: ["open", "evaluate"] as const,
    };

    expect(broker.availableOperations(scope)).toEqual(["open"]);
  });

  it("returns Browser v2 recovery vocabulary when no visible host is available", async () => {
    const broker = new BrowserAutomationBroker(options({ now: () => 10 }));
    const scope = {
      ...claims("thread-a", "workspace-a"),
      permissionCapability: "interact" as const,
      allowedOperations: ["open", "inspect", "act", "tabs"] as const,
    };

    await expect(broker.execute(scope, {
      ...request(scope),
      operation: "inspect",
      args: { includeScreenshot: false, includeDiagnostics: false },
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "HOST_UNAVAILABLE",
        effect: "none",
        recovery: "wait",
      },
    });
  });

  it("derives bounded inspect metadata from descriptor, credential, host, and target state", async () => {
    const deliveries: Array<{ channel: string; data: any }> = [];
    const broker = new BrowserAutomationBroker(options({ now: () => 10, send: (_socket, channel, data) => {
      deliveries.push({ channel, data });
      return true;
    } }));
    const hostSocket = socket("inspect-authority");
    const generation = broker.registerHost(hostSocket, {
      ...registration("inspect-authority", "workspace-a"),
      executorDescriptor: {
        ...registration("inspect-authority", "workspace-a").executorDescriptor,
        constraints: { maxTabs: 1, maxSnapshotChars: 4, maxDiagnostics: 1 },
      },
      capabilities: [
        { operation: "inspect", available: true },
      ],
    }, authorization("inspect-authority")).generation;
    updateTargets(broker, hostSocket, "inspect-authority", generation, ["thread-a"]);
    const scope = { ...claims("thread-a", "workspace-a"), allowedOperations: ["inspect"] as const };
    const pending = broker.execute(scope, { ...request(scope), operation: "inspect", args: { includeScreenshot: false, includeDiagnostics: true } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const dispatch = deliveries.find((delivery) => delivery.channel === "browserAutomation.request")!.data.dispatch;
    const target = dispatch.target;
    broker.respond(hostSocket, "inspect-authority", generation, {
      contractVersion: 1,
      requestId: dispatch.request.requestId,
      sequence: dispatch.request.sequence,
      ok: true,
      result: {
        operation: "inspect",
        observationRef: "driver-issued",
        tabs: [target, { ...target, tabId: "extra-tab" }],
        snapshot: {
          url: "https://example.test/",
          title: "Fixture",
          loading: false,
          visibleText: "123456",
          visibleTextTruncation: { truncated: false },
          elements: [], elementsTruncation: { truncated: false },
          accessibility: [], accessibilityTruncation: { truncated: false },
          console: [], consoleTruncation: { truncated: false },
          network: [], networkTruncation: { truncated: false },
          actions: [], actionsTruncation: { truncated: false },
        },
        diagnostics: ["one", "two"],
      },
    });
    await expect(pending).resolves.toMatchObject({
      ok: true,
      result: {
        operation: "inspect",
        tabs: [{ tabId: "tab-thread-a" }],
        snapshot: { visibleText: "1234", visibleTextTruncation: { truncated: true, originalCount: 6, reason: "character-limit" } },
        diagnostics: ["one"],
        capabilities: ["inspect"],
        capabilityRevision: 1,
        guidance: expect.stringContaining("electron"),
        observationRef: "driver-issued",
      },
    });
  });

  it("does not advertise act when an act-capable host omits its observation reference", async () => {
    const deliveries: Array<{ channel: string; data: any }> = [];
    const broker = new BrowserAutomationBroker(options({ now: () => 10, send: (_socket, channel, data) => {
      deliveries.push({ channel, data });
      return true;
    } }));
    const hostSocket = socket("act-without-observation");
    const base = registration("act-without-observation", "workspace-a");
    const generation = broker.registerHost(hostSocket, {
      ...base,
      executorDescriptor: { ...base.executorDescriptor, operations: ["inspect", "act"] },
      capabilities: [
        { operation: "inspect", available: true },
        { operation: "act", available: true },
      ],
    }, authorization("act-without-observation")).generation;
    updateTargets(broker, hostSocket, "act-without-observation", generation, ["thread-a"]);
    const scope = { ...claims("thread-a", "workspace-a"), permissionCapability: "interact" as const, allowedOperations: ["inspect", "act"] as const };
    const pending = broker.execute(scope, { ...request(scope), operation: "inspect", args: { includeScreenshot: false, includeDiagnostics: false } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const dispatch = deliveries.find((delivery) => delivery.channel === "browserAutomation.request")!.data.dispatch;
    const target = dispatch.target;
    broker.respond(hostSocket, "act-without-observation", generation, {
      contractVersion: 1,
      requestId: dispatch.request.requestId,
      sequence: dispatch.request.sequence,
      ok: true,
      result: { operation: "inspect", tabs: [target] },
    });
    await expect(pending).resolves.toMatchObject({
      ok: true,
      result: { operation: "inspect", capabilities: ["inspect"] },
    });
    await expect(pending).resolves.not.toHaveProperty("result.observationRef");
  });

  it("rejects descriptor revision drift before transport send", async () => {
    const replacement = socket("drift-revision-replacement");
    const scenario = pendingStatusWithMutation((broker, _socket, _generation) => {
      broker.registerHost(replacement, {
        ...registration("drift-host", "workspace-a"),
        executorDescriptor: { ...registration("drift-host", "workspace-a").executorDescriptor, capabilityRevision: 2 },
      }, authorization("drift-host"));
    });
    await expect(scenario.pending).resolves.toMatchObject({ ok: false, error: { code: "HOST_UNAVAILABLE", effect: "none", recovery: "wait" } });
    expect(scenario.deliveries).toHaveLength(0);
  });

  it("rejects credential operation drift before transport send", async () => {
    const scenario = pendingStatusWithMutation((_broker, _socket, _generation, scope) => {
      Reflect.set(scope.allowedOperations, "length", 0);
    });
    await expect(scenario.pending).resolves.toMatchObject({ ok: false, error: { code: "FORBIDDEN", effect: "none", recovery: "do_not_retry" } });
    expect(scenario.deliveries).toHaveLength(0);
  });

  it("rejects sticky host replacement before transport send", async () => {
    const replacement = socket("drift-route-replacement");
    const scenario = pendingStatusWithMutation((broker, _socket, _generation) => {
      broker.registerHost(replacement, registration("drift-host", "workspace-a"), authorization("drift-host"));
    });
    await expect(scenario.pending).resolves.toMatchObject({ ok: false, error: { code: "HOST_UNAVAILABLE", effect: "none", recovery: "wait" } });
    expect(scenario.deliveries).toHaveLength(0);
  });

  it("rejects target generation drift before transport send", async () => {
    const scenario = pendingStatusWithMutation((broker, socket, generation) => {
      broker.updateTargets(socket, "drift-host", generation, [browserTarget("drift-host", generation, 1)]);
    });
    await expect(scenario.pending).resolves.toMatchObject({ ok: false, error: { code: "STALE_TARGET_GENERATION", effect: "none", recovery: "inspect" } });
    expect(scenario.deliveries).toHaveLength(0);
  });

  it("rejects controller drift before transport send", async () => {
    const scenario = pendingStatusWithMutation((broker, socket, generation) => {
      broker.updateTargets(socket, "drift-host", generation, [browserTarget("drift-host", generation, 0, { tabId: "tab-thread-a", controller: "human", controlEpoch: 2 })]);
    });
    await expect(scenario.pending).resolves.toMatchObject({ ok: false, error: { code: "HUMAN_INTERRUPTED", effect: "none", recovery: "yield_to_user" } });
    expect(scenario.deliveries).toHaveLength(0);
  });

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
        result: inspectResult(),
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
      executorDescriptor: {
        ...registration("web", "workspace-a").executorDescriptor,
        runtime: "web",
      },
      targetIdentity: {
        worktreeIdentity: "worktree-a",
        connectionId: "desktop-web",
        workspaceId: "workspace-a",
        threadId: "thread-a",
        tabId: "tab-thread-a",
        generation: 1,
      },
      capabilities: [{ operation: "inspect", available: true }],
    }, {
      ...authorization("web"),
      allowWebRuntime: true,
    }).generation;
    updateTargets(broker, hostSocket, "web", generation, ["thread-a"]);
    const scope = {
      ...claims("thread-a", "workspace-a"),
      allowedOperations: ["inspect" as const],
    };
    const pending = broker.execute(scope, {
      ...request(scope),
      operation: "inspect",
      args: { includeScreenshot: false, includeDiagnostics: false },
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
      result: inspectResult(),
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
        { operation: "inspect", available: true },
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
      allowedOperations: ["open", "inspect"] as const,
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
      result: inspectResult(),
    });
    await expect(status).resolves.toMatchObject({ ok: true });
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
       capabilities: [
         { operation: "open", available: true },
         { operation: "inspect", available: true },
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
        result: inspectResult(),
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
      result: inspectResult(),
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
      roundTripLatency: { samples: 1, p50Ms: 25, p95Ms: 25, p99Ms: 25 },
    });
    expect(JSON.stringify(broker.reliabilityStatus())).not.toContain("thread-a");
  });

  it("reports recent Browser round-trip latency percentiles without page data", async () => {
    let now = 100;
    let delivery: any;
    const broker = new BrowserAutomationBroker(options({
      now: () => now,
      maxLatencySamples: 2,
      send: (_socket, channel, data) => {
        if (channel === "browserAutomation.request") delivery = data;
        return true;
      },
    }));
    const hostSocket = socket("latency");
    const generation = register(broker, hostSocket, "latency", "workspace-a");
    updateTargets(broker, hostSocket, "latency", generation, ["thread-a"]);
    const scope = claims("thread-a", "workspace-a");
    for (const [sequence, elapsed] of [[1, 10], [2, 20], [3, 30]] as const) {
      const pending = broker.execute(scope, request(scope, sequence));
      now += elapsed;
      broker.respond(hostSocket, "latency", generation, {
        contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
        requestId: delivery.dispatch.request.requestId,
        sequence: delivery.dispatch.request.sequence,
        ok: true,
        result: inspectResult(),
      });
      await pending;
    }

    expect(broker.reliabilityStatus().roundTripLatency).toEqual({
      samples: 2,
      p50Ms: 20,
      p95Ms: 30,
      p99Ms: 30,
    });
    expect(JSON.stringify(broker.reliabilityStatus())).not.toMatch(/thread-a|example\.test/i);
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
      allowedOperations: ["open"] as const,
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
        { operation: "inspect", available: true },
      ],
    }, authorization("bootstrap")).generation;
    const olderGeneration = broker.registerHost(olderSocket, {
      ...registration("older", "workspace-a"),
      executorDescriptor: {
        ...registration("older", "workspace-a").executorDescriptor,
        operations: ["inspect"],
      },
      capabilities: [{ operation: "inspect", available: true }],
    }, authorization("older")).generation;
    updateTargets(broker, olderSocket, "older", olderGeneration, ["thread-a"]);
    const scope = {
      ...claims("thread-a", "workspace-a"),
      allowedOperations: ["open", "inspect"] as const,
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
      result: inspectResult(),
    });
    await expect(status).resolves.toMatchObject({ ok: true });
  });

  it("creates one fresh target per keyed open while replaying duplicates", async () => {
    const deliveries: Array<{ channel: string; data: any }> = [];
    const broker = new BrowserAutomationBroker(options({
      now: () => 10,
      send: (_socket, channel, data) => {
        deliveries.push({ channel, data });
        return true;
      },
    }));
    const hostSocket = socket("fresh-open");
    const generation = broker.registerHost(hostSocket, {
      ...registration("fresh-open", "workspace-a"),
      capabilities: [{ operation: "open", available: true }],
    }, authorization("fresh-open")).generation;
    const scope = {
      ...claims("thread-a", "workspace-a"),
      allowedOperations: ["open" as const],
    };
    const open = (requestId: string, sequence: number, key: string, url: string) => broker.execute(scope, {
      ...request(scope, sequence),
      requestId,
      operation: "open",
      args: { activate: false, idempotencyKey: key, url },
    });
    const first = open("open-a", 1, "key-a", "https://example.test/a");
    const firstBootstrap = deliveries[0]!;
    const firstTarget = {
      desktopInstanceId: "desktop-fresh-open",
      windowId: 1,
      connectionGeneration: generation,
      threadId: "thread-a",
      tabId: "tab-a",
      targetGeneration: 1,
      active: false,
      focused: false,
      lastUsedAt: 10,
    };
    broker.respond(hostSocket, "fresh-open", generation, {
      contractVersion: 1,
      requestId: firstBootstrap.data.request.requestId,
      sequence: firstBootstrap.data.request.sequence,
      ok: true,
      result: { operation: "open", url: "https://example.test/a", title: "A", controlEpoch: 0, observationRef: "obs-a" },
    }, firstTarget);
    await expect(first).resolves.toMatchObject({ ok: true, result: { observationRef: "obs-a" } });

    const replay = await open("open-a-replay", 2, "key-a", "https://example.test/a");
    expect(replay).toMatchObject({ ok: true, requestId: "open-a-replay", sequence: 2, result: { observationRef: "obs-a" } });
    expect(deliveries.filter(({ channel }) => channel === "browserAutomation.bootstrap")).toHaveLength(1);

    const second = open("open-b", 3, "key-b", "https://example.test/b");
    const secondBootstrap = deliveries[1]!;
    const secondTarget = { ...firstTarget, tabId: "tab-b", lastUsedAt: 11 };
    broker.respond(hostSocket, "fresh-open", generation, {
      contractVersion: 1,
      requestId: secondBootstrap.data.request.requestId,
      sequence: secondBootstrap.data.request.sequence,
      ok: true,
      result: { operation: "open", url: "https://example.test/b", title: "B", controlEpoch: 0, observationRef: "obs-b" },
    }, secondTarget);
    await expect(second).resolves.toMatchObject({ ok: true, result: { observationRef: "obs-b" } });
    expect(secondBootstrap.data.request.args.url).toBe("https://example.test/b");
    expect(secondTarget.tabId).not.toBe(firstTarget.tabId);
    const bootstrapKeys = deliveries
      .filter(({ channel }) => channel === "browserAutomation.bootstrap")
      .map(({ data }) => data.request.args.idempotencyKey);
    expect(bootstrapKeys).toEqual(["key-a", "key-b"]);

    broker.updateTargets(hostSocket, "fresh-open", generation, []);
    const afterClose = open("open-a-after-close", 4, "key-a", "https://example.test/a");
    const afterCloseBootstrap = deliveries[2]!;
    const replacementTarget = { ...firstTarget, tabId: "tab-c" };
    broker.respond(hostSocket, "fresh-open", generation, {
      contractVersion: 1,
      requestId: afterCloseBootstrap.data.request.requestId,
      sequence: afterCloseBootstrap.data.request.sequence,
      ok: true,
      result: { operation: "open", url: "https://example.test/a", title: "A2", controlEpoch: 0, observationRef: "obs-a2" },
    }, replacementTarget);
    await expect(afterClose).resolves.toMatchObject({ ok: true, result: { observationRef: "obs-a2" } });
    expect(deliveries.filter(({ channel }) => channel === "browserAutomation.bootstrap")).toHaveLength(3);
  });

  it("serializes fresh opens with every other provider-session mutation", async () => {
    const deliveries: Array<{ channel: string; data: any }> = [];
    const broker = new BrowserAutomationBroker(options({
      now: () => 10,
      send: (_socket, channel, data) => {
        deliveries.push({ channel, data });
        return true;
      },
    }));
    const hostSocket = socket("open-lock");
    const generation = broker.registerHost(hostSocket, {
      ...registration("open-lock", "workspace-a"),
      executorDescriptor: { ...registration("open-lock", "workspace-a").executorDescriptor, operations: ["open", "tabs"] },
      capabilities: [{ operation: "open", available: true }, { operation: "tabs", available: true }],
    }, authorization("open-lock")).generation;
    broker.updateTargets(hostSocket, "open-lock", generation, [browserTarget("open-lock", generation)]);
    const scope = { ...claims("thread-a", "workspace-a"), permissionCapability: "interact" as const, allowedOperations: ["open", "tabs"] as const };
    const opened = broker.execute(scope, {
      ...request(scope), requestId: "locked-open", operation: "open" as const,
      args: { idempotencyKey: "locked-open-key", url: "https://example.test/" },
    });
    const busy = broker.execute(scope, {
      ...request(scope, 2), requestId: "tabs-during-open", operation: "tabs" as const,
      args: { action: "claim" as const, tabId: "tab-thread-a", idempotencyKey: "tabs-during-open-key", observationRef: "obs" },
    });
    await expect(busy).resolves.toMatchObject({ ok: false, error: { code: "BROWSER_BUSY" } });
    const bootstrap = deliveries.find(({ channel }) => channel === "browserAutomation.bootstrap")!;
    const target = { ...browserTarget("open-lock", generation), tabId: "agent-tab" };
    broker.respond(hostSocket, "open-lock", generation, {
      contractVersion: 1,
      requestId: bootstrap.data.request.requestId,
      sequence: bootstrap.data.request.sequence,
      ok: true,
      result: { operation: "open", url: "https://example.test/", title: "Example", controlEpoch: 0 },
    }, target);
    await expect(opened).resolves.toMatchObject({ ok: true });
  });

  it("serializes browser_act per provider session and joins exact duplicates", async () => {
    const deliveries: Array<{ channel: string; data: any }> = [];
    const broker = new BrowserAutomationBroker(options({ now: () => 10, send: (_socket, channel, data) => { deliveries.push({ channel, data }); return true; } }));
    const hostSocket = socket("act-lock");
    const generation = broker.registerHost(hostSocket, {
      ...registration("act-lock", "workspace-a"),
      executorDescriptor: { ...registration("act-lock", "workspace-a").executorDescriptor, operations: ["inspect", "act"] },
      capabilities: [{ operation: "act", available: true }],
    }, authorization("act-lock")).generation;
    broker.updateTargets(hostSocket, "act-lock", generation, [browserTarget("act-lock", generation)]);
    const scope = { ...claims("thread-a", "workspace-a"), permissionCapability: "interact" as const, allowedOperations: ["act" as const] };
    const makeAct = (requestId: string, key: string, sequence: number) => broker.execute(scope, {
      ...request(scope, sequence), requestId, operation: "act", args: { idempotencyKey: key, observationRef: "obs", deadlineMs: 10_000, steps: [{ operation: "click", target: { role: "button", accessibleName: "Save" } }] },
    });
    const first = makeAct("act-1", "same", 1);
    const joined = makeAct("act-2", "same", 2);
    const busy = makeAct("act-3", "different", 3);
    await expect(busy).resolves.toMatchObject({ ok: false, error: { code: "BROWSER_BUSY", effect: "none", recovery: "wait" } });
    const delivery = deliveries.find(({ channel }) => channel === "browserAutomation.request")!;
    broker.respond(hostSocket, "act-lock", generation, {
      contractVersion: 1, requestId: delivery.data.dispatch.request.requestId, sequence: delivery.data.dispatch.request.sequence, ok: true,
      result: { operation: "act", outcome: "completed", stoppingPosition: 1, effect: "complete", recovery: "inspect", receipts: [{ index: 0, operation: "click", status: "applied" }], finalObservation: { observationRef: "next", hostRevision: generation, documentRevision: 0, controlRevision: 0, capabilityRevision: 1, observationRevision: 1 }, nextObservationRef: "next" },
    }, delivery.data.dispatch.target);
    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(joined).resolves.toMatchObject({ ok: true, requestId: "act-2" });
    expect(deliveries.filter(({ channel }) => channel === "browserAutomation.request")).toHaveLength(1);
  });

  it("uses one correlation identity through queue, execution, page wait, settlement, and cleanup", async () => {
    const events: BrowserAutomationTelemetryEvent[] = [];
    const telemetry = new BrowserAutomationTelemetry({ sink: (event) => events.push(event) });
    const deliveries: Array<{ channel: string; data: any }> = [];
    const broker = new BrowserAutomationBroker(options({
      now: () => 10,
      telemetry,
      send: (_socket, channel, data) => { deliveries.push({ channel, data }); return true; },
    }));
    const hostSocket = socket("correlated-act");
    const base = registration("correlated-act", "workspace-a");
    const generation = broker.registerHost(hostSocket, {
      ...base,
      executorDescriptor: { ...base.executorDescriptor, operations: ["inspect", "act"] },
      capabilities: [{ operation: "act", available: true }],
    }, authorization("correlated-act")).generation;
    broker.updateTargets(hostSocket, "correlated-act", generation, [browserTarget("correlated-act", generation)]);
    const scope = {
      ...claims("thread-a", "workspace-a"),
      permissionCapability: "interact" as const,
      allowedOperations: ["act" as const],
    };
    const correlatedRequest = {
      ...request(scope),
      requestId: "correlation-request",
      operation: "act" as const,
      args: {
        idempotencyKey: "correlation-key",
        observationRef: "obs",
        deadlineMs: 10_000,
        steps: [{ operation: "wait" as const, durationMs: 1 }],
      },
    };
    const pending = broker.execute(scope, correlatedRequest);
    const delivery = deliveries.find(({ channel }) => channel === "browserAutomation.request")!;
    broker.respond(hostSocket, "correlated-act", generation, {
      contractVersion: 1,
      requestId: correlatedRequest.requestId,
      sequence: correlatedRequest.sequence,
      ok: true,
      result: {
        operation: "act",
        outcome: "completed",
        stoppingPosition: 1,
        effect: "none",
        recovery: "inspect",
        receipts: [{ index: 0, operation: "wait", status: "applied" }],
        finalObservation: {
          observationRef: "next",
          hostRevision: generation,
          documentRevision: 0,
          controlRevision: 0,
          capabilityRevision: 1,
          observationRevision: 1,
        },
        nextObservationRef: "next",
      },
    }, delivery.data.dispatch.target);

    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(events.map((event) => event.stage)).toEqual([
      "configuration",
      "admission",
      "queueing",
      "execution",
      "page-waiting",
      "settlement",
      "cleanup",
    ]);
    expect(new Set(events.map((event) => event.correlationId))).toEqual(new Set(["correlation-request"]));
  });

  it("serializes browser_evaluate, joins exact duplicates, and hashes expressions for conflicts", async () => {
    const deliveries: Array<{ channel: string; data: any }> = [];
    const broker = new BrowserAutomationBroker(options({ now: () => 10, send: (_socket, channel, data) => { deliveries.push({ channel, data }); return true; } }));
    const hostSocket = socket("evaluate-lock");
    const generation = broker.registerHost(hostSocket, {
      ...registration("evaluate-lock", "workspace-a"),
      executorDescriptor: { ...registration("evaluate-lock", "workspace-a").executorDescriptor, operations: ["inspect", "evaluate"] },
      capabilities: [{ operation: "evaluate", available: true }],
    }, authorization("evaluate-lock")).generation;
    broker.updateTargets(hostSocket, "evaluate-lock", generation, [browserTarget("evaluate-lock", generation)]);
    const scope = { ...claims("thread-a", "workspace-a"), permissionCapability: "privileged" as const, allowedOperations: ["evaluate" as const] };
    const makeEvaluate = (requestId: string, key: string, expression: string, sequence: number) => broker.execute(scope, {
      ...request(scope, sequence), requestId, operation: "evaluate", args: {
        idempotencyKey: key,
        observationRef: "obs",
        deadlineMs: 10_000,
        expression,
        awaitPromise: true,
        timeoutMs: 1_000,
      },
    });
    const first = makeEvaluate("evaluate-1", "same", "document.title", 1);
    const joined = makeEvaluate("evaluate-2", "same", "document.title", 2);
    const busy = makeEvaluate("evaluate-3", "different", "document.URL", 3);
    await expect(busy).resolves.toMatchObject({ ok: false, error: { code: "BROWSER_BUSY", effect: "none", recovery: "wait" } });
    const delivery = deliveries.find(({ channel }) => channel === "browserAutomation.request")!;
    broker.respond(hostSocket, "evaluate-lock", generation, {
      contractVersion: 1, requestId: delivery.data.dispatch.request.requestId, sequence: delivery.data.dispatch.request.sequence, ok: true,
      result: {
        operation: "evaluate",
        outcome: "completed",
        stoppingPosition: 1,
        effect: "complete",
        recovery: "inspect",
        receipts: [{ index: 0, operation: "evaluate", status: "applied" }],
        finalObservation: {
          observationRef: "next",
          hostRevision: generation,
          documentRevision: 1,
          controlRevision: 0,
          capabilityRevision: 1,
          observationRevision: 1,
        },
        nextObservationRef: "next",
        valueJson: "\"Example\"",
      },
    }, delivery.data.dispatch.target);
    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(joined).resolves.toMatchObject({ ok: true, requestId: "evaluate-2" });
    expect(deliveries.filter(({ channel }) => channel === "browserAutomation.request")).toHaveLength(1);

    const conflict = await makeEvaluate("evaluate-4", "same", "document.URL", 4);
    expect(conflict).toMatchObject({ ok: false, error: { code: "IDEMPOTENCY_CONFLICT" } });
    expect(conflict.ok && JSON.stringify(conflict)).toBe(false);
  });

  it("rejects a raw Electron evaluation result at the broker boundary", async () => {
    const deliveries: Array<{ channel: string; data: any }> = [];
    const broker = new BrowserAutomationBroker(options({ now: () => 10, send: (_socket, channel, data) => {
      deliveries.push({ channel, data });
      return true;
    } }));
    const hostSocket = socket("raw-evaluate");
    const generation = broker.registerHost(hostSocket, {
      ...registration("raw-evaluate", "workspace-a"),
      executorDescriptor: { ...registration("raw-evaluate", "workspace-a").executorDescriptor, operations: ["inspect", "evaluate"] },
      capabilities: [{ operation: "evaluate", available: true }],
    }, authorization("raw-evaluate")).generation;
    broker.updateTargets(hostSocket, "raw-evaluate", generation, [browserTarget("raw-evaluate", generation)]);
    const scope = { ...claims("thread-a", "workspace-a"), permissionCapability: "privileged" as const, allowedOperations: ["evaluate" as const] };
    const pending = broker.execute(scope, {
      ...request(scope),
      operation: "evaluate",
      args: {
        idempotencyKey: "raw-evaluate-key",
        observationRef: "observation-ref",
        deadlineMs: 10_000,
        expression: "globalThis.SECRET_SOURCE",
        awaitPromise: true,
        timeoutMs: 1_000,
      },
    });
    const delivery = deliveries.find(({ channel }) => channel === "browserAutomation.request")!;
    broker.respond(hostSocket, "raw-evaluate", generation, {
      contractVersion: 1,
      requestId: delivery.data.dispatch.request.requestId,
      sequence: delivery.data.dispatch.request.sequence,
      ok: true,
      result: { operation: "evaluate", valueJson: "\"SECRET_RESULT\"", controlEpoch: 0 },
    }, delivery.data.dispatch.target);

    const result = await pending;
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST", effect: "none" } });
    expect(JSON.stringify(result)).not.toContain("SECRET_RESULT");
  });

  it("routes browser_tabs selection to the requested tab and keeps lifecycle state sticky", async () => {
    const deliveries: Array<{ channel: string; data: any }> = [];
    const broker = new BrowserAutomationBroker(options({
      now: () => 10,
      send: (_socket, channel, data) => {
        deliveries.push({ channel, data });
        return true;
      },
    }));
    const hostSocket = socket("tabs-routing");
    const generation = broker.registerHost(hostSocket, {
      ...registration("tabs-routing", "workspace-a"),
      executorDescriptor: { ...registration("tabs-routing", "workspace-a").executorDescriptor, operations: ["inspect", "tabs"] },
      capabilities: [{ operation: "tabs", available: true }],
    }, authorization("tabs-routing")).generation;
    broker.updateTargets(hostSocket, "tabs-routing", generation, [
      { ...browserTarget("tabs-routing", generation), tabId: "tab-a", focused: true },
      { ...browserTarget("tabs-routing", generation), tabId: "tab-b", focused: false, lastUsedAt: 2 },
    ]);
    const scope = { ...claims("thread-a", "workspace-a"), permissionCapability: "interact" as const, allowedOperations: ["tabs" as const] };
    const tabsRequest = (requestId: string, sequence: number, args: any) => ({
      ...request(scope, sequence),
      requestId,
      operation: "tabs" as const,
      args,
    });
    const first = broker.execute(scope, tabsRequest("tabs-select", 1, {
      action: "select", tabId: "tab-b", idempotencyKey: "tabs-select-key", observationRef: "obs-1",
    }));
    const firstDelivery = deliveries.find(({ channel }) => channel === "browserAutomation.request")!;
    expect(firstDelivery.data.dispatch.target.tabId).toBe("tab-b");
    broker.respond(hostSocket, "tabs-routing", generation, {
      contractVersion: 1,
      requestId: firstDelivery.data.dispatch.request.requestId,
      sequence: firstDelivery.data.dispatch.request.sequence,
      ok: true,
      result: { operation: "tabs", action: "select", currentTabId: "tab-b", observationRef: "obs-2", tabs: [] },
    }, { ...firstDelivery.data.dispatch.target, focused: true, lastUsedAt: 20 });
    await expect(first).resolves.toMatchObject({ ok: true, result: { action: "select", currentTabId: "tab-b" } });

    const release = broker.execute(scope, tabsRequest("tabs-release", 2, {
      action: "release", idempotencyKey: "tabs-release-key", observationRef: "obs-2",
    }));
    const releaseDelivery = deliveries.filter(({ channel }) => channel === "browserAutomation.request").at(-1)!;
    expect(releaseDelivery.data.dispatch.target.tabId).toBe("tab-b");
    expect(releaseDelivery.data.dispatch.target.lastUsedAt).toBe(20);
    broker.respond(hostSocket, "tabs-routing", generation, {
      contractVersion: 1,
      requestId: releaseDelivery.data.dispatch.request.requestId,
      sequence: releaseDelivery.data.dispatch.request.sequence,
      ok: true,
      result: { operation: "tabs", action: "release", tabs: [] },
    }, releaseDelivery.data.dispatch.target);
    await expect(release).resolves.toMatchObject({ ok: true, result: { action: "release" } });
    expect(broker.status().assignments).toBe(0);
  });

  it("accepts a successful close response after the target is intentionally removed", async () => {
    const deliveries: Array<{ channel: string; data: any }> = [];
    const broker = new BrowserAutomationBroker(options({
      now: () => 10,
      send: (_socket, channel, data) => {
        deliveries.push({ channel, data });
        return true;
      },
    }));
    const hostSocket = socket("tabs-finalize");
    const generation = broker.registerHost(hostSocket, {
      ...registration("tabs-finalize", "workspace-a"),
      executorDescriptor: { ...registration("tabs-finalize", "workspace-a").executorDescriptor, operations: ["inspect", "tabs"] },
      capabilities: [{ operation: "tabs", available: true }],
    }, authorization("tabs-finalize")).generation;
    broker.updateTargets(hostSocket, "tabs-finalize", generation, [browserTarget("tabs-finalize", generation)]);
    const scope = { ...claims("thread-a", "workspace-a"), permissionCapability: "interact" as const, allowedOperations: ["tabs" as const] };
    const pending = broker.execute(scope, {
      ...request(scope),
      operation: "tabs" as const,
      args: {
        action: "close" as const,
        tabId: "tab-thread-a",
        idempotencyKey: "close-key",
        observationRef: "obs-1",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const delivery = deliveries.find(({ channel }) => channel === "browserAutomation.request")!;

    broker.updateTargets(hostSocket, "tabs-finalize", generation, []);
    broker.respond(hostSocket, "tabs-finalize", generation, {
      contractVersion: 1,
      requestId: delivery.data.dispatch.request.requestId,
      sequence: delivery.data.dispatch.request.sequence,
      ok: true,
      result: { operation: "tabs", action: "close", tabs: [] },
    }, delivery.data.dispatch.target);

    await expect(pending).resolves.toMatchObject({ ok: true, result: { action: "close", tabs: [] } });
    expect(broker.status()).toMatchObject({ pending: 0, assignments: 0 });
    await expect(broker.execute(scope, {
      ...request(scope, 2),
      operation: "tabs" as const,
      args: { action: "close" as const, tabId: "tab-thread-a", idempotencyKey: "close-again", observationRef: "obs-2" },
    })).resolves.toMatchObject({ ok: false, error: { code: "TAB_UNAVAILABLE" } });
  });

  it("replays browser_tabs idempotency keys and shares mutation exclusion with browser_act", async () => {
    const deliveries: Array<{ channel: string; data: any }> = [];
    const broker = new BrowserAutomationBroker(options({
      now: () => 10,
      send: (_socket, channel, data) => {
        deliveries.push({ channel, data });
        return true;
      },
    }));
    const hostSocket = socket("tabs-lock");
    const generation = broker.registerHost(hostSocket, {
      ...registration("tabs-lock", "workspace-a"),
      executorDescriptor: { ...registration("tabs-lock", "workspace-a").executorDescriptor, operations: ["inspect", "tabs", "act"] },
      capabilities: [{ operation: "tabs", available: true }, { operation: "act", available: true }],
    }, authorization("tabs-lock")).generation;
    broker.updateTargets(hostSocket, "tabs-lock", generation, [browserTarget("tabs-lock", generation)]);
    const scope = { ...claims("thread-a", "workspace-a"), permissionCapability: "interact" as const, allowedOperations: ["tabs", "act"] as const };
    const tabs = (requestId: string, sequence: number, idempotencyKey: string) => broker.execute(scope, {
      ...request(scope, sequence),
      requestId,
      operation: "tabs" as const,
      args: { action: "claim" as const, tabId: "tab-thread-a", idempotencyKey, observationRef: "obs-1" },
    });
    const first = tabs("tabs-lock-1", 1, "same-key");
    const duplicate = tabs("tabs-lock-2", 2, "same-key");
    const conflict = tabs("tabs-lock-3", 3, "other-key");
    await expect(conflict).resolves.toMatchObject({ ok: false, error: { code: "BROWSER_BUSY" } });
    expect(deliveries.filter(({ channel }) => channel === "browserAutomation.request")).toHaveLength(1);
    const delivery = deliveries.find(({ channel }) => channel === "browserAutomation.request")!;
    broker.respond(hostSocket, "tabs-lock", generation, {
      contractVersion: 1,
      requestId: delivery.data.dispatch.request.requestId,
      sequence: delivery.data.dispatch.request.sequence,
      ok: true,
      result: { operation: "tabs", action: "claim", currentTabId: "tab-thread-a", tabs: [] },
    }, delivery.data.dispatch.target);
    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(duplicate).resolves.toMatchObject({ ok: true, requestId: "tabs-lock-2", sequence: 2 });
  });

  it("notifies the routed host after its provider-session assignment is cleared", async () => {
    const deliveries: Array<{ channel: string; data: any }> = [];
    const broker = new BrowserAutomationBroker(options({
      now: () => 10,
      send: (_socket, channel, data) => {
        deliveries.push({ channel, data });
        return true;
      },
    }));
    const hostSocket = socket("tabs-release-notify");
    const generation = broker.registerHost(hostSocket, {
      ...registration("tabs-release-notify", "workspace-a"),
      executorDescriptor: { ...registration("tabs-release-notify", "workspace-a").executorDescriptor, operations: ["inspect", "tabs"] },
      capabilities: [{ operation: "tabs", available: true }],
    }, authorization("tabs-release-notify")).generation;
    broker.updateTargets(hostSocket, "tabs-release-notify", generation, [browserTarget("tabs-release-notify", generation)]);
    const scope = { ...claims("thread-a", "workspace-a"), permissionCapability: "interact" as const, allowedOperations: ["tabs" as const] };
    const pending = broker.execute(scope, {
      ...request(scope),
      operation: "tabs" as const,
      args: { action: "claim" as const, tabId: "tab-thread-a", idempotencyKey: "notify-key", observationRef: "obs-1" },
    });
    const delivery = deliveries.find(({ channel }) => channel === "browserAutomation.request")!;
    broker.respond(hostSocket, "tabs-release-notify", generation, {
      contractVersion: 1,
      requestId: delivery.data.dispatch.request.requestId,
      sequence: delivery.data.dispatch.request.sequence,
      ok: true,
      result: { operation: "tabs", action: "claim", currentTabId: "tab-thread-a", tabs: [] },
    }, delivery.data.dispatch.target);
    await pending;
    expect(broker.status().assignments).toBe(1);
    broker.updateTargets(hostSocket, "tabs-release-notify", generation, []);
    expect(broker.status().assignments).toBe(0);
    expect(broker.releaseProviderSession("cursor", scope.providerSessionId, "provider-session-ended")).toBe(0);
    expect(deliveries.find(({ channel }) => channel === "browserAutomation.sessionRelease")).toEqual({
      channel: "browserAutomation.sessionRelease",
      data: { hostId: "tabs-release-notify", generation, providerSessionId: scope.providerSessionId, reason: "provider-session-ended" },
    });
  });

  it("drops keyed open replay when its host reconnects", async () => {
    const deliveries: Array<{ channel: string; data: any }> = [];
    const broker = new BrowserAutomationBroker(options({
      now: () => 10,
      send: (_socket, channel, data) => {
        deliveries.push({ channel, data });
        return true;
      },
    }));
    const firstSocket = socket("reconnect-first");
    const firstGeneration = broker.registerHost(firstSocket, {
      ...registration("reconnect-first", "workspace-a"),
      capabilities: [{ operation: "open", available: true }],
    }, authorization("reconnect-first")).generation;
    const scope = { ...claims("thread-a", "workspace-a"), allowedOperations: ["open" as const] };
    const open = (requestId: string, sequence: number) => broker.execute(scope, {
      ...request(scope, sequence),
      requestId,
      operation: "open",
      args: { activate: false, idempotencyKey: "reconnect-key", url: "https://example.test/reconnect" },
    });
    const first = open("reconnect-open-1", 1);
    const firstBootstrap = deliveries[0]!;
    const firstTarget = {
      desktopInstanceId: "desktop-reconnect-first",
      windowId: 1,
      connectionGeneration: firstGeneration,
      threadId: "thread-a",
      tabId: "tab-first",
      targetGeneration: 1,
      active: false,
      focused: false,
      lastUsedAt: 10,
    };
    broker.respond(firstSocket, "reconnect-first", firstGeneration, {
      contractVersion: 1,
      requestId: firstBootstrap.data.request.requestId,
      sequence: firstBootstrap.data.request.sequence,
      ok: true,
      result: { operation: "open", url: "https://example.test/reconnect", title: "First", controlEpoch: 0, observationRef: "obs-first" },
    }, firstTarget);
    await expect(first).resolves.toMatchObject({ ok: true, result: { observationRef: "obs-first" } });

    broker.disconnect(firstSocket);
    const replacementSocket = socket("reconnect-first");
    const replacementGeneration = broker.registerHost(replacementSocket, {
      ...registration("reconnect-first", "workspace-a"),
      capabilities: [{ operation: "open", available: true }],
    }, authorization("reconnect-first")).generation;
    const second = open("reconnect-open-2", 2);
    const secondBootstrap = deliveries[1]!;
    const secondTarget = { ...firstTarget, connectionGeneration: replacementGeneration, tabId: "tab-second" };
    broker.respond(replacementSocket, "reconnect-first", replacementGeneration, {
      contractVersion: 1,
      requestId: secondBootstrap.data.request.requestId,
      sequence: secondBootstrap.data.request.sequence,
      ok: true,
      result: { operation: "open", url: "https://example.test/reconnect", title: "Second", controlEpoch: 0, observationRef: "obs-second" },
    }, secondTarget);
    await expect(second).resolves.toMatchObject({ ok: true, result: { observationRef: "obs-second" } });
    expect(deliveries.filter(({ channel }) => channel === "browserAutomation.bootstrap")).toHaveLength(2);
  });

  it("retries a keyed open after a failed bootstrap", async () => {
    const deliveries: Array<{ channel: string; data: any }> = [];
    const broker = new BrowserAutomationBroker(options({
      now: () => 10,
      send: (_socket, channel, data) => {
        deliveries.push({ channel, data });
        return true;
      },
    }));
    const hostSocket = socket("failed-open");
    const generation = broker.registerHost(hostSocket, {
      ...registration("failed-open", "workspace-a"),
      capabilities: [{ operation: "open", available: true }],
    }, authorization("failed-open")).generation;
    const scope = { ...claims("thread-a", "workspace-a"), allowedOperations: ["open" as const] };
    const open = (requestId: string, sequence: number) => broker.execute(scope, {
      ...request(scope, sequence),
      requestId,
      operation: "open",
      args: { activate: false, idempotencyKey: "failed-key", url: "https://example.test/failed" },
    });
    const first = open("failed-open-1", 1);
    const firstBootstrap = deliveries[0]!;
    broker.respond(hostSocket, "failed-open", generation, {
      contractVersion: 1,
      requestId: firstBootstrap.data.request.requestId,
      sequence: firstBootstrap.data.request.sequence,
      ok: false,
      error: { code: "HOST_UNAVAILABLE", message: "bootstrap failed", retryable: true },
    });
    await expect(first).resolves.toMatchObject({ ok: false, error: { code: "HOST_UNAVAILABLE" } });

    const retry = open("failed-open-2", 2);
    expect(deliveries.filter(({ channel }) => channel === "browserAutomation.bootstrap")).toHaveLength(2);
    const retryBootstrap = deliveries[1]!;
    broker.respond(hostSocket, "failed-open", generation, {
      contractVersion: 1,
      requestId: retryBootstrap.data.request.requestId,
      sequence: retryBootstrap.data.request.sequence,
      ok: false,
      error: { code: "HOST_UNAVAILABLE", message: "retry failed", retryable: true },
    });
    await expect(retry).resolves.toMatchObject({ ok: false, error: { code: "HOST_UNAVAILABLE" } });
  });

  it("retries a pending keyed open after host disconnect", async () => {
    const deliveries: Array<{ channel: string; data: any }> = [];
    const broker = new BrowserAutomationBroker(options({
      now: () => 10,
      send: (_socket, channel, data) => {
        deliveries.push({ channel, data });
        return true;
      },
    }));
    const hostSocket = socket("pending-open");
    broker.registerHost(hostSocket, {
      ...registration("pending-open", "workspace-a"),
      capabilities: [{ operation: "open", available: true }],
    }, authorization("pending-open")).generation;
    const scope = { ...claims("thread-a", "workspace-a"), allowedOperations: ["open" as const] };
    const input = (requestId: string, sequence: number) => ({
      ...request(scope, sequence),
      requestId,
      operation: "open" as const,
      args: { activate: false, idempotencyKey: "pending-key", url: "https://example.test/pending" },
    });
    const first = broker.execute(scope, input("pending-open-1", 1));
    broker.disconnect(hostSocket);
    await expect(first).resolves.toMatchObject({ ok: false, error: { code: "HOST_UNAVAILABLE" } });

    const replacementSocket = socket("pending-open-replacement");
    const replacementGeneration = broker.registerHost(replacementSocket, {
      ...registration("pending-open-replacement", "workspace-a"),
      capabilities: [{ operation: "open", available: true }],
    }, authorization("pending-open-replacement")).generation;
    const retry = broker.execute(scope, input("pending-open-2", 2));
    expect(deliveries.filter(({ channel }) => channel === "browserAutomation.bootstrap")).toHaveLength(2);
    const retryBootstrap = deliveries[1]!;
    broker.respond(replacementSocket, "pending-open-replacement", replacementGeneration, {
      contractVersion: 1,
      requestId: retryBootstrap.data.request.requestId,
      sequence: retryBootstrap.data.request.sequence,
      ok: true,
      result: { operation: "open", url: "https://example.test/pending", title: "Retry", controlEpoch: 0 },
    }, {
      desktopInstanceId: "desktop-pending-open-replacement",
      windowId: 1,
      connectionGeneration: replacementGeneration,
      threadId: "thread-a",
      tabId: "tab-retry",
      targetGeneration: 1,
      active: false,
      focused: false,
      lastUsedAt: 10,
    });
    await expect(retry).resolves.toMatchObject({ ok: true });
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
        result: inspectResult(),
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
