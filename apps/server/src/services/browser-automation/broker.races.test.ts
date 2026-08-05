import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_AUTOMATION_CONTRACT_VERSION,
  BrowserAutomationHostDispatchSchema,
  BrowserAutomationRequestSchema,
  BrowserAutomationResponseSchema,
  type BrowserAutomationHostRegistration,
  type BrowserAutomationOperation,
  type BrowserAutomationRequest,
  type BrowserAutomationResponse,
} from "@mcode/contracts";
import type { WebSocket } from "ws";
import { BrowserAutomationBroker } from "./broker.js";
import type { BrowserAutomationCredentialClaims } from "./credential-registry.js";

type Delivery = { socket: WebSocket; channel: string; data: unknown };

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function socket(name: string): WebSocket {
  return { name } as unknown as WebSocket;
}

function authorization(hostId: string) {
  return {
    desktopInstanceId: `desktop-${hostId}`,
    worktreeIdentity: "worktree-a",
    allowedWorkspaceIds: ["workspace-a"],
  };
}

function registration(
  hostId: string,
  operations: readonly BrowserAutomationOperation[],
): BrowserAutomationHostRegistration {
  return {
    contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
    hostId,
    runtime: "electron",
    desktopInstanceId: `desktop-${hostId}`,
    worktreeIdentity: "worktree-a",
    workspaceIds: ["workspace-a"],
    executorDescriptor: {
      runtime: "electron",
      operations: ["inspect", ...operations],
      constraints: { maxTabs: 32, maxSnapshotChars: 20_000, maxDiagnostics: 200 },
      capabilityRevision: 1,
    },
    capabilities: operations.map((operation) => ({ operation, available: true })),
    maxPendingRequests: 4,
    connectedAt: 1,
  };
}

function register(
  broker: BrowserAutomationBroker,
  targetSocket: WebSocket,
  hostId: string,
  operations: readonly BrowserAutomationOperation[],
): number {
  return broker.registerHost(targetSocket, registration(hostId, operations), authorization(hostId)).generation;
}

function target(
  hostId: string,
  generation: number,
  tabId = "tab-thread-a",
  targetGeneration = 1,
) {
  return {
    desktopInstanceId: `desktop-${hostId}`,
    windowId: 1,
    connectionGeneration: generation,
    threadId: "thread-a",
    tabId,
    targetGeneration,
    active: true,
    focused: true,
    lastUsedAt: targetGeneration,
  };
}

function claims(
  allowedOperations: readonly BrowserAutomationOperation[],
): BrowserAutomationCredentialClaims {
  return {
    credentialId: "credential-thread-a",
    providerId: "cursor",
    providerSessionId: "provider-thread-a",
    mcodeSessionId: "mcode-thread-a",
    threadId: "thread-a",
    workspaceId: "workspace-a",
    worktreeIdentity: "worktree-a",
    permissionCapability: "privileged",
    allowedOperations,
    issuedAt: 1,
    expiresAt: 100_000,
  };
}

function request(
  scope: BrowserAutomationCredentialClaims,
  requestId: string,
  sequence: number,
  operation: BrowserAutomationOperation,
  args: unknown,
  deadline = 10_000,
): BrowserAutomationRequest {
  return BrowserAutomationRequestSchema().parse({
    contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
    workspaceId: scope.workspaceId,
    threadId: scope.threadId,
    providerSessionId: scope.providerSessionId,
    providerInstanceId: scope.mcodeSessionId,
    requestId,
    sequence,
    deadline,
    expectedControlEpoch: 0,
    operation,
    args,
  });
}

function openRequest(
  scope: BrowserAutomationCredentialClaims,
  requestId: string,
  sequence: number,
  idempotencyKey: string,
  url = "https://example.test/",
): BrowserAutomationRequest {
  return request(scope, requestId, sequence, "open", { idempotencyKey, url });
}

function actRequest(
  scope: BrowserAutomationCredentialClaims,
  requestId: string,
  sequence: number,
  idempotencyKey: string,
  deadline = 10_000,
): BrowserAutomationRequest {
  return request(scope, requestId, sequence, "act", {
    idempotencyKey,
    observationRef: "observation-thread-a",
    deadlineMs: 1_000,
    steps: [{ operation: "click", target: { role: "button", accessibleName: "Save" } }],
  }, deadline);
}

function openResult(url: string, observationRef: string) {
  return {
    operation: "open" as const,
    url,
    title: "Example",
    controlEpoch: 0,
    observationRef,
  };
}

function actResult() {
  return {
    operation: "act" as const,
    outcome: "completed" as const,
    stoppingPosition: 1,
    effect: "complete" as const,
    recovery: "inspect" as const,
    receipts: [{ index: 0, operation: "click", status: "applied" as const }],
    finalObservation: {
      observationRef: "observation-next",
      hostRevision: 1,
      documentRevision: 1,
      controlRevision: 0,
      capabilityRevision: 1,
      observationRevision: 1,
    },
    nextObservationRef: "observation-next",
  };
}

function responseFor(requestValue: BrowserAutomationRequest, result: unknown): BrowserAutomationResponse {
  return BrowserAutomationResponseSchema().parse({
    contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
    requestId: requestValue.requestId,
    sequence: requestValue.sequence,
    ok: true,
    result,
  });
}

function dispatchFor(delivery: Delivery) {
  if (delivery.channel !== "browserAutomation.request") throw new Error("Expected a request delivery");
  return BrowserAutomationHostDispatchSchema().parse((delivery.data as { dispatch: unknown }).dispatch);
}

function bootstrapRequestFor(delivery: Delivery): BrowserAutomationRequest {
  if (delivery.channel !== "browserAutomation.bootstrap") throw new Error("Expected a bootstrap delivery");
  return BrowserAutomationRequestSchema().parse((delivery.data as { request: unknown }).request);
}

function expectKnownFailure(response: BrowserAutomationResponse, code: string): void {
  if (response.ok) throw new Error("Expected a browser automation failure");
  expect(response.error.code).toBe(code);
  expect(["none", "partial", "complete"]).toContain(response.error.effect);
  expect(["inspect", "reopen", "wait", "yield_to_user", "do_not_retry"]).toContain(response.error.recovery);
}

describe("BrowserAutomationBroker race mechanics", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("bootstrap-disconnect-reconnect + bootstrap-concurrent-open + bootstrap-idempotent-replay keep one target owner", async () => {
    const deliveries: Delivery[] = [];
    const firstBootstrapReady = deferred<void>();
    let bootstrapCount = 0;
    const broker = new BrowserAutomationBroker({
      now: () => 1_000,
      send: (targetSocket, channel, data) => {
        deliveries.push({ socket: targetSocket, channel, data });
        if (channel === "browserAutomation.bootstrap" && ++bootstrapCount === 1) firstBootstrapReady.resolve();
        return true;
      },
    });
    try {
      const firstSocket = socket("sticky");
      const firstGeneration = register(broker, firstSocket, "sticky", ["open", "act"]);
      const scope = claims(["open", "act"]);
      const firstRequest = openRequest(scope, "open-first", 1, "sticky-open");
      const first = broker.execute(scope, firstRequest);
      await firstBootstrapReady.promise;
      const joined = broker.execute(scope, openRequest(scope, "open-joined", 2, "sticky-open"));
      const competing = broker.execute(scope, openRequest(scope, "open-competing", 3, "other-open"));
      const firstDelivery = deliveries.find(({ channel }) => channel === "browserAutomation.bootstrap")!;
      const firstBootstrap = bootstrapRequestFor(firstDelivery);
      expect(deliveries.filter(({ channel }) => channel === "browserAutomation.bootstrap")).toHaveLength(1);
      expectKnownFailure(await BrowserAutomationResponseSchema().parseAsync(await competing), "BROWSER_BUSY");

      broker.disconnect(firstSocket);
      expectKnownFailure(await BrowserAutomationResponseSchema().parseAsync(await first), "HOST_UNAVAILABLE");
      expectKnownFailure(await BrowserAutomationResponseSchema().parseAsync(await joined), "HOST_UNAVAILABLE");
      expect(broker.status()).toEqual({ hosts: 0, pending: 0, assignments: 0 });

      const replacementSocket = socket("sticky-replacement");
      const replacementGeneration = register(broker, replacementSocket, "sticky", ["open", "act"]);
      const retryRequest = openRequest(scope, "open-retry", 4, "sticky-open");
      const retry = broker.execute(scope, retryRequest);
      const retryDelivery = deliveries.filter(({ channel }) => channel === "browserAutomation.bootstrap").at(-1)!;
      const retryBootstrap = bootstrapRequestFor(retryDelivery);
      expect(() => broker.respond(
        firstSocket,
        "sticky",
        firstGeneration,
        responseFor(firstBootstrap, openResult("https://example.test/", "stale-observation")),
      )).toThrow("stale or invalid");
      const authoritativeTarget = target("sticky", replacementGeneration, "tab-authoritative", 1);
      broker.respond(
        replacementSocket,
        "sticky",
        replacementGeneration,
        responseFor(retryBootstrap, openResult("https://example.test/", "observation-authoritative")),
        authoritativeTarget,
      );
      expect(await BrowserAutomationResponseSchema().parseAsync(await retry)).toMatchObject({
        ok: true,
        result: { observationRef: "observation-authoritative" },
      });
      expect(await BrowserAutomationResponseSchema().parseAsync(await broker.execute(
        scope,
        openRequest(scope, "open-replay", 5, "sticky-open"),
      ))).toMatchObject({ ok: true, requestId: "open-replay", sequence: 5 });
      expectKnownFailure(await BrowserAutomationResponseSchema().parseAsync(await broker.execute(
        scope,
        openRequest(scope, "open-conflict", 6, "sticky-open", "https://other.test/"),
      )), "IDEMPOTENCY_CONFLICT");
      expect(deliveries.filter(({ channel }) => channel === "browserAutomation.bootstrap")).toHaveLength(2);
      expect(broker.status()).toEqual({ hosts: 1, pending: 0, assignments: 1 });
    } finally {
      broker.shutdown();
    }
  });

  it("cleanup-replacement + cleanup-late-response reject stale target responses", async () => {
    const deliveries: Delivery[] = [];
    const broker = new BrowserAutomationBroker({
      now: () => 1_000,
      send: (targetSocket, channel, data) => {
        deliveries.push({ socket: targetSocket, channel, data });
        return true;
      },
    });
    try {
      const hostSocket = socket("target-replacement");
      const generation = register(broker, hostSocket, "target-replacement", ["open", "act"]);
      const scope = claims(["open", "act"]);
      const open = openRequest(scope, "open-target", 1, "target-open");
      const opened = broker.execute(scope, open);
      const bootstrap = bootstrapRequestFor(deliveries.find(({ channel }) => channel === "browserAutomation.bootstrap")!);
      const firstTarget = target("target-replacement", generation, "tab-authoritative", 1);
      broker.respond(hostSocket, "target-replacement", generation, responseFor(bootstrap, openResult("https://example.test/", "target-observation")), firstTarget);
      expect(await BrowserAutomationResponseSchema().parseAsync(await opened)).toMatchObject({ ok: true });

      const oldMutationRequest = actRequest(scope, "act-old", 2, "target-old");
      const oldMutation = broker.execute(scope, oldMutationRequest);
      expect(dispatchFor(deliveries.filter(({ channel }) => channel === "browserAutomation.request").at(-1)!)).toMatchObject({ target: firstTarget });
      const replacementTarget = target("target-replacement", generation, "tab-authoritative", 2);
      broker.updateTargets(hostSocket, "target-replacement", generation, [replacementTarget]);
      expectKnownFailure(await BrowserAutomationResponseSchema().parseAsync(await oldMutation), "TAB_UNAVAILABLE");
      broker.respond(hostSocket, "target-replacement", generation, responseFor(oldMutationRequest, actResult()), firstTarget);

      const newMutationRequest = actRequest(scope, "act-new", 3, "target-new");
      const newMutation = broker.execute(scope, newMutationRequest);
      expect(dispatchFor(deliveries.filter(({ channel }) => channel === "browserAutomation.request").at(-1)!)).toMatchObject({ target: replacementTarget });
      broker.respond(hostSocket, "target-replacement", generation, responseFor(newMutationRequest, actResult()), replacementTarget);
      expect(await BrowserAutomationResponseSchema().parseAsync(await newMutation)).toMatchObject({ ok: true, result: { operation: "act" } });
      expect(broker.status()).toEqual({ hosts: 1, pending: 0, assignments: 1 });
      expect(broker.reliabilityStatus()).toMatchObject({ dispatched: 3, succeeded: 2, failed: 1, hostLosses: 1 });
    } finally {
      broker.shutdown();
    }
  });

  it("action-competing-mutation + action-cancel settle provider cancellation exactly once", async () => {
    const deliveries: Delivery[] = [];
    const broker = new BrowserAutomationBroker({
      now: () => 1_000,
      send: (targetSocket, channel, data) => {
        deliveries.push({ socket: targetSocket, channel, data });
        return true;
      },
    });
    try {
      const hostSocket = socket("mutation");
      const generation = register(broker, hostSocket, "mutation", ["act"]);
      broker.updateTargets(hostSocket, "mutation", generation, [target("mutation", generation)]);
      const scope = claims(["act"]);
      const firstRequest = actRequest(scope, "act-first", 1, "act-key");
      const first = broker.execute(scope, firstRequest);
      expectKnownFailure(await BrowserAutomationResponseSchema().parseAsync(await broker.execute(scope, actRequest(scope, "act-competing", 2, "other-act-key"))), "BROWSER_BUSY");
      expect(deliveries.filter(({ channel }) => channel === "browserAutomation.request")).toHaveLength(1);
      expect(broker.cancelFromProvider(scope, firstRequest.requestId, firstRequest.sequence)).toBe(true);
      expectKnownFailure(await BrowserAutomationResponseSchema().parseAsync(await first), "OPERATION_CANCELLED");
      expect(broker.cancelFromProvider(scope, firstRequest.requestId, firstRequest.sequence)).toBe(false);
      const reliability = broker.reliabilityStatus();
      broker.respond(hostSocket, "mutation", generation, responseFor(firstRequest, actResult()));
      expect(broker.status()).toMatchObject({ pending: 0, assignments: 1 });
      expect(broker.reliabilityStatus()).toEqual(reliability);
    } finally {
      broker.shutdown();
    }
  });

  it("action-timeout + cleanup-late-response keep deadline responses terminal", async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const deliveries: Delivery[] = [];
    const broker = new BrowserAutomationBroker({
      now: () => now,
      send: (targetSocket, channel, data) => {
        deliveries.push({ socket: targetSocket, channel, data });
        return true;
      },
    });
    try {
      const hostSocket = socket("timeout");
      const generation = register(broker, hostSocket, "timeout", ["act"]);
      broker.updateTargets(hostSocket, "timeout", generation, [target("timeout", generation)]);
      const scope = claims(["act"]);
      const requestValue = actRequest(scope, "act-timeout", 1, "timeout-key", now + 5);
      const pending = broker.execute(scope, requestValue);
      expect(deliveries.find(({ channel }) => channel === "browserAutomation.request")).toBeDefined();
      now += 5;
      await vi.advanceTimersByTimeAsync(5);
      expectKnownFailure(await BrowserAutomationResponseSchema().parseAsync(await pending), "DEADLINE_EXCEEDED");
      const reliability = broker.reliabilityStatus();
      broker.respond(hostSocket, "timeout", generation, responseFor(requestValue, actResult()));
      expect(broker.status()).toMatchObject({ pending: 0, assignments: 1 });
      expect(broker.reliabilityStatus()).toEqual(reliability);
    } finally {
      broker.shutdown();
    }
  });

  it("bootstrap-disconnect-reconnect + cleanup-replacement reject old host generations", async () => {
    const deliveries: Delivery[] = [];
    const broker = new BrowserAutomationBroker({
      now: () => 1_000,
      send: (targetSocket, channel, data) => {
        deliveries.push({ socket: targetSocket, channel, data });
        return true;
      },
    });
    try {
      const oldSocket = socket("disconnect");
      const oldGeneration = register(broker, oldSocket, "disconnect", ["act"]);
      broker.updateTargets(oldSocket, "disconnect", oldGeneration, [target("disconnect", oldGeneration)]);
      const scope = claims(["act"]);
      const oldRequest = actRequest(scope, "act-disconnect", 1, "disconnect-key");
      const old = broker.execute(scope, oldRequest);
      broker.disconnect(oldSocket);
      expectKnownFailure(await BrowserAutomationResponseSchema().parseAsync(await old), "HOST_UNAVAILABLE");
      const reliability = broker.reliabilityStatus();
      expect(broker.status()).toEqual({ hosts: 0, pending: 0, assignments: 0 });
      expect(() => broker.respond(oldSocket, "disconnect", oldGeneration, responseFor(oldRequest, actResult()))).toThrow("stale or invalid");
      expect(broker.reliabilityStatus()).toEqual(reliability);

      const replacementSocket = socket("disconnect-replacement");
      const replacementGeneration = register(broker, replacementSocket, "disconnect", ["act"]);
      broker.updateTargets(replacementSocket, "disconnect", replacementGeneration, [target("disconnect", replacementGeneration)]);
      const newerRequest = actRequest(scope, "act-newer", 2, "newer-key");
      const newer = broker.execute(scope, newerRequest);
      const newerDelivery = deliveries.filter(({ channel }) => channel === "browserAutomation.request").at(-1)!;
      expect(dispatchFor(newerDelivery).connection.connectionGeneration).toBe(replacementGeneration);
      expect(() => broker.respond(oldSocket, "disconnect", oldGeneration, responseFor(oldRequest, actResult()))).toThrow("stale or invalid");
      broker.respond(replacementSocket, "disconnect", replacementGeneration, responseFor(newerRequest, actResult()));
      expect(await BrowserAutomationResponseSchema().parseAsync(await newer)).toMatchObject({ ok: true, result: { operation: "act" } });
    } finally {
      broker.shutdown();
    }
  });

  it("bootstrap-late-creation + cleanup-late-response release and shutdown to baseline", async () => {
    const deliveries: Delivery[] = [];
    const broker = new BrowserAutomationBroker({
      now: () => 1_000,
      send: (targetSocket, channel, data) => {
        deliveries.push({ socket: targetSocket, channel, data });
        return true;
      },
    });
    try {
      const hostSocket = socket("teardown");
      const generation = register(broker, hostSocket, "teardown", ["open"]);
      const scope = claims(["open"]);
      const firstRequest = openRequest(scope, "teardown-open", 1, "teardown-key");
      const first = broker.execute(scope, firstRequest);
      const firstDelivery = deliveries.find(({ channel }) => channel === "browserAutomation.bootstrap")!;
      expect(broker.releaseProviderSession(scope.providerId, scope.providerSessionId)).toBe(0);
      expectKnownFailure(await BrowserAutomationResponseSchema().parseAsync(await first), "OPERATION_CANCELLED");
      expect(broker.status()).toEqual({ hosts: 1, pending: 0, assignments: 0 });

      const retryRequest = openRequest(scope, "teardown-retry", 2, "teardown-key");
      const retry = broker.execute(scope, retryRequest);
      const retryDelivery = deliveries.filter(({ channel }) => channel === "browserAutomation.bootstrap").at(-1)!;
      expect(retryDelivery).not.toBe(firstDelivery);
      broker.respond(hostSocket, "teardown", generation, responseFor(firstRequest, openResult("https://example.test/", "late-old")), target("teardown", generation, "tab-old", 1));
      const retryBootstrap = bootstrapRequestFor(retryDelivery);
      const retryTarget = target("teardown", generation, "tab-retry", 1);
      broker.respond(hostSocket, "teardown", generation, responseFor(retryBootstrap, openResult("https://example.test/", "retry-observation")), retryTarget);
      expect(await BrowserAutomationResponseSchema().parseAsync(await retry)).toMatchObject({ ok: true, result: { observationRef: "retry-observation" } });
      expect(broker.status()).toEqual({ hosts: 1, pending: 0, assignments: 1 });

      broker.shutdown();
      expect(broker.status()).toEqual({ hosts: 0, pending: 0, assignments: 0 });
      const reliability = broker.reliabilityStatus();
      expect(() => broker.respond(hostSocket, "teardown", generation, responseFor(retryBootstrap, openResult("https://example.test/", "late-after-shutdown")), retryTarget)).toThrow("stale or invalid");
      expect(broker.reliabilityStatus()).toEqual(reliability);
      expect(broker.status()).toEqual({ hosts: 0, pending: 0, assignments: 0 });
    } finally {
      broker.shutdown();
    }
  });
});
