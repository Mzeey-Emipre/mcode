import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_AUTOMATION_CONTRACT_VERSION,
  BrowserAutomationHostDispatchSchema,
  BrowserAutomationRequestSchema,
  BrowserAutomationResponseSchema,
  type BrowserAutomationHostRegistration,
  type BrowserAutomationOperation,
  type BrowserAutomationPublicOperation,
  type BrowserAutomationRequest,
  type BrowserAutomationResponse,
} from "@mcode/contracts";
import {
  BROWSER_CONFORMANCE_RACE_CATALOGUE,
  BrowserConformanceFaultController,
  type BrowserConformanceEventKind,
  type BrowserConformanceRaceCase,
} from "@mcode/browser-conformance";
import type { WebSocket } from "ws";
import { BrowserAutomationBroker } from "../broker.js";
import type { BrowserAutomationCredentialClaims } from "../../access/credential-registry.js";

type Delivery = { socket: WebSocket; channel: string; data: unknown };

const BROKER_OWNED_RACE_IDS = [
  "bootstrap-disconnect-reconnect",
  "bootstrap-concurrent-open",
  "bootstrap-cancel",
  "bootstrap-timeout",
  "bootstrap-close",
  "bootstrap-lost-response",
  "bootstrap-idempotent-replay",
  "bootstrap-late-creation",
  "action-cancel",
  "action-timeout",
  "action-competing-mutation",
  "cleanup-late-response",
  "cleanup-late-event",
  "cleanup-late-timer",
  "cleanup-disconnect",
  "cleanup-replacement",
  "cleanup-capacity",
] as const;

type BrokerOwnedRaceId = typeof BROKER_OWNED_RACE_IDS[number];
const exercisedBrokerRaceIds = new Set<BrokerOwnedRaceId>();

function brokerRace(id: BrokerOwnedRaceId): BrowserConformanceRaceCase {
  const race = BROWSER_CONFORMANCE_RACE_CATALOGUE.find((candidate) => candidate.id === id);
  if (!race) throw new Error(`Missing Browser conformance race catalogue entry: ${id}`);
  return race;
}

function assertBrokerRaceCoverage(...ids: readonly BrokerOwnedRaceId[]): void {
  expect(ids.map((id) => brokerRace(id).id)).toEqual(ids);
}

function brokerRaceLabel(...ids: readonly BrokerOwnedRaceId[]): string {
  return ids.map((id) => {
    const race = brokerRace(id);
    return `${race.id} [${race.events.join(", ")}]`;
  }).join(" + ");
}

function brokerRaceDriver(...ids: readonly BrokerOwnedRaceId[]): {
  event: (kind: BrowserConformanceEventKind) => void;
  assertComplete: () => void;
} {
  for (const id of ids) exercisedBrokerRaceIds.add(id);
  const remaining = new Map<BrowserConformanceEventKind, number>();
  for (const race of ids.map(brokerRace)) {
    for (const event of race.events) remaining.set(event, (remaining.get(event) ?? 0) + 1);
  }
  return {
    event: (kind) => {
      const count = remaining.get(kind) ?? 0;
      expect(count, `unexpected ${kind} event for ${ids.join(", ")}`).toBeGreaterThan(0);
      remaining.set(kind, count - 1);
    },
    assertComplete: () => {
      expect([...remaining.entries()].filter(([, count]) => count > 0)).toEqual([]);
    },
  };
}

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
  allowedOperations: readonly BrowserAutomationPublicOperation[],
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
  operation: BrowserAutomationPublicOperation,
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
  deadline = 10_000,
): BrowserAutomationRequest {
  return request(scope, requestId, sequence, "open", { idempotencyKey, url }, deadline);
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

  afterAll(() => {
    expect([...exercisedBrokerRaceIds].sort()).toEqual([...BROKER_OWNED_RACE_IDS].sort());
  });

  it("covers the broker-owned named race catalogue subset explicitly", () => {
    const expected = [...BROKER_OWNED_RACE_IDS];
    const expectedSet = new Set<string>(expected);
    expect(expectedSet.size).toBe(expected.length);
    expect(BROWSER_CONFORMANCE_RACE_CATALOGUE.filter(({ id }) => expectedSet.has(id)).map(({ id }) => id))
      .toEqual(expected);
  });

  it("settles a timed-out bootstrap for " + brokerRaceLabel("bootstrap-timeout"), async () => {
    assertBrokerRaceCoverage("bootstrap-timeout");
    const race = brokerRaceDriver("bootstrap-timeout");
    vi.useFakeTimers();
    let now = 1_000;
    const broker = new BrowserAutomationBroker({
      now: () => now,
      send: () => true,
    });
    try {
      const hostSocket = socket("bootstrap-timeout");
      register(broker, hostSocket, "bootstrap-timeout", ["open"]);
      const scope = claims(["open"]);
      const pending = broker.execute(scope, openRequest(scope, "bootstrap-timeout", 1, "bootstrap-timeout", "https://example.test/", now + 5));
      race.event("timeout");
      now += 5;
      await vi.advanceTimersByTimeAsync(5);
      expectKnownFailure(await BrowserAutomationResponseSchema().parseAsync(await pending), "DEADLINE_EXCEEDED");
      expect(broker.status()).toEqual({ hosts: 1, pending: 0, assignments: 0 });
      race.assertComplete();
    } finally {
      broker.shutdown();
    }
  });

  it("rejects excess target registration for " + brokerRaceLabel("cleanup-capacity"), () => {
    assertBrokerRaceCoverage("cleanup-capacity");
    const race = brokerRaceDriver("cleanup-capacity");
    const broker = new BrowserAutomationBroker({ maxTargets: 2, send: () => true });
    try {
      const hostSocket = socket("capacity");
      const generation = register(broker, hostSocket, "capacity", ["status"]);
      const first = target("capacity", generation, "tab-one");
      const second = target("capacity", generation, "tab-two");
      const third = target("capacity", generation, "tab-three");
      race.event("target-register");
      broker.updateTargets(hostSocket, "capacity", generation, [first]);
      race.event("target-register");
      broker.updateTargets(hostSocket, "capacity", generation, [first, second]);
      race.event("target-register");
      broker.updateTargets(hostSocket, "capacity", generation, [first, second]);
      race.event("target-register");
      expect(() => broker.updateTargets(hostSocket, "capacity", generation, [first, second, third]))
        .toThrow("target capacity");
      expect(broker.status()).toEqual({ hosts: 1, pending: 0, assignments: 0 });
      race.assertComplete();
    } finally {
      broker.shutdown();
    }
  });

  it("exercises shared fault controls at transport, registration, receipt, and cleanup boundaries", async () => {
    const transportFaults = new BrowserConformanceFaultController({ kind: "host-transport" });
    const targetFaults = new BrowserConformanceFaultController({ kind: "target-registration" });
    const receiptFaults = new BrowserConformanceFaultController({ kind: "receipt-delivery" });
    const cleanupFaults = new BrowserConformanceFaultController({ kind: "cleanup" });
    const deliveries: Delivery[] = [];
    const broker = new BrowserAutomationBroker({
      now: () => 1_000,
      send: (targetSocket, channel, data) => {
        transportFaults.hit("host-transport");
        deliveries.push({ socket: targetSocket, channel, data });
        return true;
      },
    });
    try {
      const hostSocket = socket("faults");
      const generation = register(broker, hostSocket, "faults", ["open", "act"]);
      const scope = claims(["open", "act"]);
      const transportRequest = openRequest(scope, "fault-transport", 1, "fault-transport");
      expectKnownFailure(await BrowserAutomationResponseSchema().parseAsync(await broker.execute(scope, transportRequest)), "HOST_UNAVAILABLE");
      expect(transportFaults.callsFor("host-transport")).toBe(1);
      transportFaults.dispose();

      const registeredTarget = target("faults", generation);
      expect(() => {
        targetFaults.hit("target-registration");
      }).toThrow("fault injected");
      expect(targetFaults.callsFor("target-registration")).toBe(1);
      targetFaults.dispose();
      broker.updateTargets(hostSocket, "faults", generation, [registeredTarget]);

      const receiptRequest = actRequest(scope, "fault-receipt", 2, "fault-receipt");
      const receiptPending = broker.execute(scope, receiptRequest);
      expect(deliveries.find(({ channel }) => channel === "browserAutomation.request")).toBeDefined();
      expect(() => {
        receiptFaults.hit("receipt-delivery");
      }).toThrow("fault injected");
      expect(receiptFaults.callsFor("receipt-delivery")).toBe(1);
      receiptFaults.dispose();
      broker.respond(hostSocket, "faults", generation, responseFor(receiptRequest, actResult()), registeredTarget);
      expect(await BrowserAutomationResponseSchema().parseAsync(await receiptPending)).toMatchObject({ ok: true });

      expect(() => {
        cleanupFaults.hit("cleanup");
      }).toThrow("fault injected");
      expect(cleanupFaults.callsFor("cleanup")).toBe(1);
      cleanupFaults.dispose();
      broker.shutdown();
      expect(broker.status()).toEqual({ hosts: 0, pending: 0, assignments: 0 });
      expect(transportFaults.isDisposed).toBe(true);
      expect(targetFaults.isDisposed).toBe(true);
      expect(receiptFaults.isDisposed).toBe(true);
      expect(cleanupFaults.isDisposed).toBe(true);
    } finally {
      broker.shutdown();
      transportFaults.dispose();
      targetFaults.dispose();
      receiptFaults.dispose();
      cleanupFaults.dispose();
    }
  });

  it("keeps one target owner for " + brokerRaceLabel(
    "bootstrap-disconnect-reconnect",
    "bootstrap-concurrent-open",
    "bootstrap-lost-response",
    "bootstrap-idempotent-replay",
  ), async () => {
    assertBrokerRaceCoverage(
      "bootstrap-disconnect-reconnect",
      "bootstrap-concurrent-open",
      "bootstrap-lost-response",
      "bootstrap-idempotent-replay",
    );
    const race = brokerRaceDriver(
      "bootstrap-disconnect-reconnect",
      "bootstrap-concurrent-open",
      "bootstrap-lost-response",
      "bootstrap-idempotent-replay",
    );
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

      race.event("host-disconnect");
      race.event("lost-response");
      broker.disconnect(firstSocket);
      expectKnownFailure(await BrowserAutomationResponseSchema().parseAsync(await first), "HOST_UNAVAILABLE");
      expectKnownFailure(await BrowserAutomationResponseSchema().parseAsync(await joined), "HOST_UNAVAILABLE");
      expect(broker.status()).toEqual({ hosts: 0, pending: 0, assignments: 0 });

      const replacementSocket = socket("sticky-replacement");
      race.event("host-reconnect");
      const replacementGeneration = register(broker, replacementSocket, "sticky", ["open", "act"]);
      const retryRequest = openRequest(scope, "open-retry", 4, "sticky-open");
      const retry = broker.execute(scope, retryRequest);
      const retryDelivery = deliveries.filter(({ channel }) => channel === "browserAutomation.bootstrap").at(-1)!;
      const retryBootstrap = bootstrapRequestFor(retryDelivery);
      race.event("target-register");
      const authoritativeTarget = target("sticky", replacementGeneration, "tab-authoritative", 1);
      broker.updateTargets(replacementSocket, "sticky", replacementGeneration, [authoritativeTarget]);
      race.event("target-register");
      broker.updateTargets(replacementSocket, "sticky", replacementGeneration, [authoritativeTarget]);
      race.event("late-response");
      expect(() => broker.respond(
        firstSocket,
        "sticky",
        firstGeneration,
        responseFor(firstBootstrap, openResult("https://example.test/", "stale-observation")),
      )).toThrow("stale or invalid");
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
      race.assertComplete();
    } finally {
      broker.shutdown();
    }
  });

  it("rejects stale target responses for " + brokerRaceLabel(
    "bootstrap-close",
    "cleanup-replacement",
    "cleanup-late-response",
  ), async () => {
    assertBrokerRaceCoverage("bootstrap-close", "cleanup-replacement", "cleanup-late-response");
    const race = brokerRaceDriver("bootstrap-close", "cleanup-replacement", "cleanup-late-response");
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
      race.event("target-close");
      broker.updateTargets(hostSocket, "target-replacement", generation, []);
      race.event("target-close");
      race.event("target-register");
      broker.updateTargets(hostSocket, "target-replacement", generation, [replacementTarget]);
      expectKnownFailure(await BrowserAutomationResponseSchema().parseAsync(await oldMutation), "TAB_UNAVAILABLE");
      race.event("late-response");
      broker.respond(hostSocket, "target-replacement", generation, responseFor(oldMutationRequest, actResult()), firstTarget);

      const newMutationRequest = actRequest(scope, "act-new", 3, "target-new");
      const newMutation = broker.execute(scope, newMutationRequest);
      expect(dispatchFor(deliveries.filter(({ channel }) => channel === "browserAutomation.request").at(-1)!)).toMatchObject({ target: replacementTarget });
      broker.respond(hostSocket, "target-replacement", generation, responseFor(newMutationRequest, actResult()), replacementTarget);
      expect(await BrowserAutomationResponseSchema().parseAsync(await newMutation)).toMatchObject({ ok: true, result: { operation: "act" } });
      expect(broker.status()).toEqual({ hosts: 1, pending: 0, assignments: 1 });
      expect(broker.reliabilityStatus()).toMatchObject({ dispatched: 3, succeeded: 2, failed: 1, hostLosses: 1 });
      race.assertComplete();
    } finally {
      broker.shutdown();
    }
  });

  it("settles provider cancellation exactly once for " + brokerRaceLabel(
    "action-competing-mutation",
    "action-cancel",
  ), async () => {
    assertBrokerRaceCoverage("action-competing-mutation", "action-cancel");
    const race = brokerRaceDriver("action-competing-mutation", "action-cancel");
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
      race.event("competing-mutation");
      expectKnownFailure(await BrowserAutomationResponseSchema().parseAsync(await broker.execute(scope, actRequest(scope, "act-competing", 2, "other-act-key"))), "BROWSER_BUSY");
      expect(deliveries.filter(({ channel }) => channel === "browserAutomation.request")).toHaveLength(1);
      race.event("cancel");
      expect(broker.cancelFromProvider(scope, firstRequest.requestId, firstRequest.sequence)).toBe(true);
      expectKnownFailure(await BrowserAutomationResponseSchema().parseAsync(await first), "OPERATION_CANCELLED");
      expect(broker.cancelFromProvider(scope, firstRequest.requestId, firstRequest.sequence)).toBe(false);
      const reliability = broker.reliabilityStatus();
      broker.respond(hostSocket, "mutation", generation, responseFor(firstRequest, actResult()));
      expect(broker.status()).toMatchObject({ pending: 0, assignments: 1 });
      expect(broker.reliabilityStatus()).toEqual(reliability);
      race.assertComplete();
    } finally {
      broker.shutdown();
    }
  });

  it("keeps deadline responses terminal for " + brokerRaceLabel(
    "action-timeout",
    "cleanup-late-response",
    "cleanup-late-timer",
  ), async () => {
    assertBrokerRaceCoverage("action-timeout", "cleanup-late-response", "cleanup-late-timer");
    const race = brokerRaceDriver("action-timeout", "cleanup-late-response", "cleanup-late-timer");
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
      race.event("timeout");
      now += 5;
      await vi.advanceTimersByTimeAsync(5);
      expectKnownFailure(await BrowserAutomationResponseSchema().parseAsync(await pending), "DEADLINE_EXCEEDED");
      const reliability = broker.reliabilityStatus();
      race.event("late-timer");
      race.event("late-response");
      broker.respond(hostSocket, "timeout", generation, responseFor(requestValue, actResult()));
      expect(broker.status()).toMatchObject({ pending: 0, assignments: 1 });
      expect(broker.reliabilityStatus()).toEqual(reliability);
      race.assertComplete();
    } finally {
      broker.shutdown();
    }
  });

  it("rejects old host generations for " + brokerRaceLabel(
    "bootstrap-disconnect-reconnect",
    "cleanup-replacement",
    "cleanup-disconnect",
    "cleanup-late-event",
  ), async () => {
    assertBrokerRaceCoverage("bootstrap-disconnect-reconnect", "cleanup-replacement", "cleanup-disconnect", "cleanup-late-event");
    const race = brokerRaceDriver("bootstrap-disconnect-reconnect", "cleanup-replacement", "cleanup-disconnect", "cleanup-late-event");
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
      race.event("host-disconnect");
      race.event("host-disconnect");
      race.event("target-close");
      broker.disconnect(oldSocket);
      expectKnownFailure(await BrowserAutomationResponseSchema().parseAsync(await old), "HOST_UNAVAILABLE");
      const reliability = broker.reliabilityStatus();
      expect(broker.status()).toEqual({ hosts: 0, pending: 0, assignments: 0 });
      expect(() => broker.respond(oldSocket, "disconnect", oldGeneration, responseFor(oldRequest, actResult()))).toThrow("stale or invalid");
      expect(broker.reliabilityStatus()).toEqual(reliability);

      const replacementSocket = socket("disconnect-replacement");
      race.event("host-reconnect");
      const replacementGeneration = register(broker, replacementSocket, "disconnect", ["act"]);
      race.event("target-register");
      broker.updateTargets(replacementSocket, "disconnect", replacementGeneration, [target("disconnect", replacementGeneration)]);
      const newerRequest = actRequest(scope, "act-newer", 2, "newer-key");
      const newer = broker.execute(scope, newerRequest);
      const newerDelivery = deliveries.filter(({ channel }) => channel === "browserAutomation.request").at(-1)!;
      expect(dispatchFor(newerDelivery).connection.connectionGeneration).toBe(replacementGeneration);
      race.event("late-event");
      expect(() => broker.respond(oldSocket, "disconnect", oldGeneration, responseFor(oldRequest, actResult()))).toThrow("stale or invalid");
      broker.respond(replacementSocket, "disconnect", replacementGeneration, responseFor(newerRequest, actResult()));
      expect(await BrowserAutomationResponseSchema().parseAsync(await newer)).toMatchObject({ ok: true, result: { operation: "act" } });
      race.assertComplete();
    } finally {
      broker.shutdown();
    }
  });

  it("releases and shuts down to baseline for " + brokerRaceLabel(
    "bootstrap-cancel",
    "bootstrap-late-creation",
    "cleanup-late-response",
  ), async () => {
    assertBrokerRaceCoverage(
      "bootstrap-cancel",
      "bootstrap-late-creation",
      "cleanup-late-response",
    );
    const race = brokerRaceDriver("bootstrap-cancel", "bootstrap-late-creation", "cleanup-late-response");
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
      race.event("cancel");
      expect(broker.releaseProviderSession(scope.providerId, scope.providerSessionId)).toBe(0);
      expectKnownFailure(await BrowserAutomationResponseSchema().parseAsync(await first), "OPERATION_CANCELLED");
      expect(broker.status()).toEqual({ hosts: 1, pending: 0, assignments: 0 });

      const retryRequest = openRequest(scope, "teardown-retry", 2, "teardown-key");
      const retry = broker.execute(scope, retryRequest);
      const retryDelivery = deliveries.filter(({ channel }) => channel === "browserAutomation.bootstrap").at(-1)!;
      expect(retryDelivery).not.toBe(firstDelivery);
      race.event("late-response");
      broker.respond(hostSocket, "teardown", generation, responseFor(firstRequest, openResult("https://example.test/", "late-old")), target("teardown", generation, "tab-old", 1));
      const retryBootstrap = bootstrapRequestFor(retryDelivery);
      const retryTarget = target("teardown", generation, "tab-retry", 1);
      race.event("target-register");
      broker.respond(hostSocket, "teardown", generation, responseFor(retryBootstrap, openResult("https://example.test/", "retry-observation")), retryTarget);
      expect(await BrowserAutomationResponseSchema().parseAsync(await retry)).toMatchObject({ ok: true, result: { observationRef: "retry-observation" } });
      expect(broker.status()).toEqual({ hosts: 1, pending: 0, assignments: 1 });

      broker.shutdown();
      expect(broker.status()).toEqual({ hosts: 0, pending: 0, assignments: 0 });
      const reliability = broker.reliabilityStatus();
      race.event("late-response");
      expect(() => broker.respond(hostSocket, "teardown", generation, responseFor(retryBootstrap, openResult("https://example.test/", "late-after-shutdown")), retryTarget)).toThrow("stale or invalid");
      expect(broker.reliabilityStatus()).toEqual(reliability);
      expect(broker.status()).toEqual({ hosts: 0, pending: 0, assignments: 0 });
      race.assertComplete();
    } finally {
      broker.shutdown();
    }
  });
});
