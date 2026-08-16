import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  BROWSER_AUTOMATION_CONTRACT_VERSION,
  BrowserAutomationHostDispatchTargetSchema,
  BrowserAutomationResponseSchema,
  type BrowserAutomationHostRegistration,
  type BrowserAutomationHostDispatch,
  type BrowserAutomationResponse,
} from "@mcode/contracts";
import {
  BROWSER_CONFORMANCE_RACE_CATALOGUE,
  BrowserConformanceFaultController,
  createBrowserConformanceScenario,
  normalizeBrowserConformanceRun,
  createBrowserConformanceResourceSnapshot,
  type BrowserConformanceEventKind,
} from "@mcode/browser-conformance";
import { BrowserAutomationBroker } from "./broker.js";
import { BrowserAutomationCredentialRegistry } from "./credential-registry.js";
import { BrowserAutomationMcpHandler } from "./mcp-handler.js";

const socket = { name: "conformance-host" } as never;

const MCP_OWNED_RACE_IDS = ["cleanup-late-event", "cleanup-disconnect"] as const;

function mcpRaceLabel(): string {
  return MCP_OWNED_RACE_IDS.map((id) => {
    const race = BROWSER_CONFORMANCE_RACE_CATALOGUE.find((candidate) => candidate.id === id);
    if (!race) throw new Error(`Missing Browser conformance race catalogue entry: ${id}`);
    return `${race.id} [${race.events.join(", ")}]`;
  }).join(" + ");
}

function mcpRaceDriver(): {
  event: (kind: BrowserConformanceEventKind) => void;
  assertComplete: () => void;
} {
  const remaining = new Map<BrowserConformanceEventKind, number>();
  for (const id of MCP_OWNED_RACE_IDS) {
    const race = BROWSER_CONFORMANCE_RACE_CATALOGUE.find((candidate) => candidate.id === id);
    if (!race) throw new Error(`Missing Browser conformance race catalogue entry: ${id}`);
    for (const event of race.events) remaining.set(event, (remaining.get(event) ?? 0) + 1);
  }
  return {
    event: (kind) => {
      const count = remaining.get(kind) ?? 0;
      expect(count, `unexpected ${kind} event for MCP conformance`).toBeGreaterThan(0);
      remaining.set(kind, count - 1);
    },
    assertComplete: () => expect([...remaining.entries()].filter(([, count]) => count > 0)).toEqual([]),
  };
}

function registration(): BrowserAutomationHostRegistration {
  return {
    contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
    hostId: "host-conformance",
    runtime: "electron",
    desktopInstanceId: "desktop-conformance",
    worktreeIdentity: "worktree-conformance",
    workspaceIds: ["workspace-conformance"],
    executorDescriptor: {
      runtime: "electron",
      operations: ["inspect", "act"],
      constraints: { maxTabs: 4, maxSnapshotChars: 4_000, maxDiagnostics: 4 },
      capabilityRevision: 1,
    },
    capabilities: [
      { operation: "inspect", available: true },
      { operation: "act", available: true },
    ],
    maxPendingRequests: 2,
    connectedAt: 1,
  };
}

function target(generation: number) {
  return BrowserAutomationHostDispatchTargetSchema().parse({
    desktopInstanceId: "desktop-conformance",
    windowId: 1,
    connectionGeneration: generation,
    threadId: "thread-conformance",
    tabId: "tab-conformance",
    targetGeneration: 1,
    active: true,
    focused: true,
    lastUsedAt: 1,
  });
}

describe("authenticated Browser MCP conformance", () => {
  let server: Server | undefined;
  let broker: BrowserAutomationBroker;
  let credentials: BrowserAutomationCredentialRegistry;

  afterEach(async () => {
    broker?.shutdown();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  });

  it("covers the MCP-owned named race catalogue subset explicitly", () => {
    const expected = [...MCP_OWNED_RACE_IDS];
    const expectedSet = new Set<string>(expected);
    expect(expectedSet.size).toBe(expected.length);
    expect(BROWSER_CONFORMANCE_RACE_CATALOGUE.filter(({ id }) => expectedSet.has(id)).map(({ id }) => id))
      .toEqual(expected);
  });

  it("crosses MCP transport into broker, normalizes success, and rejects late host activity for " + mcpRaceLabel(), async () => {
    const race = mcpRaceDriver();
    const transportFaults = new BrowserConformanceFaultController();
    const targetFaults = new BrowserConformanceFaultController();
    const receiptFaults = new BrowserConformanceFaultController();
    const cleanupFaults = new BrowserConformanceFaultController();
    let dispatch: BrowserAutomationHostDispatch | undefined;
    const dispatchResolvers: Array<(value: BrowserAutomationHostDispatch) => void> = [];
    const nextDispatch = (): Promise<BrowserAutomationHostDispatch> => new Promise((resolve) => {
      dispatchResolvers.push(resolve);
    });
    let generation = 0;
    credentials = new BrowserAutomationCredentialRegistry({ now: () => 1_000 });
    broker = new BrowserAutomationBroker({
      now: () => 1_000,
      send: (_socket, channel, data) => {
        transportFaults.hit("host-transport");
        if (channel === "browserAutomation.request") {
          dispatch = (data as { dispatch: BrowserAutomationHostDispatch }).dispatch;
          dispatchResolvers.shift()?.(dispatch);
        }
        return true;
      },
    });
    const baselineReliability = broker.reliabilityStatus();
    const registered = broker.registerHost(socket, registration(), {
      desktopInstanceId: "desktop-conformance",
      worktreeIdentity: "worktree-conformance",
      allowedWorkspaceIds: ["workspace-conformance"],
    });
    generation = registered.generation;
    targetFaults.hit("target-registration");
    broker.updateTargets(socket, "host-conformance", generation, [target(generation)]);
    const issued = credentials.issue({
      providerId: "codex",
      providerSessionId: "provider-conformance",
      mcodeSessionId: "mcode-conformance",
      threadId: "thread-conformance",
      workspaceId: "workspace-conformance",
      worktreeIdentity: "worktree-conformance",
      permissionCapability: "interact",
      allowedOperations: ["inspect", "act"],
    });
    const handler = new BrowserAutomationMcpHandler({ credentials, broker, now: () => 1_000 });
    const scenario = createBrowserConformanceScenario({
      id: "authenticated-mcp-inspect-act",
      seed: "mcp-oracle-1034",
      commands: [
        { id: "inspect", operation: "inspect" },
        {
          id: "act",
          operation: "act",
          args: {
            idempotencyKey: "act-conformance-1",
            observationRef: "observation-conformance-1",
            deadlineMs: 5_000,
            steps: [
              { operation: "click", target: { semanticId: "fixture-action-button" } },
              { operation: "type", text: "partial fixture text" },
              { operation: "press", key: "Enter" },
            ],
          },
        },
      ],
      cleanup: { baseline: createBrowserConformanceResourceSnapshot({}) },
    });
    server = createServer((req, res) => void handler.handle(req, res));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("conformance server did not bind");
    const endpoint = `http://127.0.0.1:${address.port}/mcp`;
    const dispatchReady = nextDispatch();
    const call = fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${issued.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: `browser_${scenario.commands[0]!.operation}`, arguments: scenario.commands[0]!.args ?? {} },
      }),
    });
    dispatch = await dispatchReady;
    const response: BrowserAutomationResponse = BrowserAutomationResponseSchema().parse({
      contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
      requestId: dispatch!.request.requestId,
      sequence: dispatch!.request.sequence,
      ok: true,
      result: {
        operation: "inspect", tabs: [], capabilities: ["inspect", "act"], observationRef: "observation-conformance-1",
      },
    });
    expect(response.ok).toBe(true);
    receiptFaults.hit("receipt-delivery");
    broker.respond(socket, "host-conformance", generation, response, dispatch!.target);
    const payload = await (await call).json() as { result: { content: [{ text: string }] } };
    const observed = JSON.parse(payload.result.content[0].text) as { operation: string; capabilities: string[] };
    const responseOperation = response.ok && "operation" in response.result ? response.result.operation : "unknown";
    expect(observed.operation).toBe(responseOperation);
    const terminalStatus = response.ok ? "satisfied" : "failed";
    const terminalOutcome = response.ok ? "completed" : "failed";
    const terminalEffect = response.ok ? "none" : response.error.effect;
    const terminalRecovery = response.ok ? "none" : response.error.recovery;
    const normalized = normalizeBrowserConformanceRun({
      receipts: [{
        operation: responseOperation,
        status: terminalStatus,
        effect: terminalEffect,
        recovery: terminalRecovery,
        errorCode: response.ok ? null : response.error.code,
      }],
      outcome: {
        status: terminalOutcome,
        effect: terminalEffect,
        recovery: terminalRecovery,
        errorCode: response.ok ? null : response.error.code,
      },
      finalState: { readiness: "ready", resources: scenario.cleanup.baseline },
    });
    expect(normalized.outcome.status).toBe(terminalOutcome);
    expect(normalized.outcome.effect).toBe(terminalEffect);
    expect(normalized.outcome.recovery).toBe(terminalRecovery);
    expect(normalized.receipts.some((receipt) => receipt.status === "unknown" || receipt.operation === "unknown")).toBe(false);
    expect(JSON.parse(payload.result.content[0].text)).toMatchObject({ operation: "inspect", capabilities: ["inspect", "act"] });

    const actDispatchReady = nextDispatch();
    const actCall = fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${issued.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: `browser_${scenario.commands[1]!.operation}`,
          arguments: scenario.commands[1]!.args,
        },
      }),
    });
    const actDispatch = await actDispatchReady;
    expect(actDispatch.request.operation).toBe("act");
    const scenarioActArgs = scenario.commands[1]!.args as { steps: readonly { operation: string }[] };
    expect(actDispatch.request.args.steps).toHaveLength(scenarioActArgs.steps.length);
    expect(actDispatch.request.args.steps.map((step: { operation: string }) => step.operation))
      .toEqual(scenarioActArgs.steps.map((step) => step.operation));
    const actResponse: BrowserAutomationResponse = BrowserAutomationResponseSchema().parse({
      contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
      requestId: actDispatch.request.requestId,
      sequence: actDispatch.request.sequence,
      ok: true,
      result: {
        operation: "act",
        outcome: "interrupted",
        stoppingPosition: 1,
        effect: "partial",
        recovery: "inspect",
        receipts: [
          { index: 0, operation: "click", status: "applied" },
          { index: 1, operation: "type", status: "interrupted" },
          { index: 2, operation: "press", status: "skipped" },
        ],
        finalObservation: {
          observationRef: "observation-conformance-2",
          hostRevision: 1,
          documentRevision: 1,
          controlRevision: 0,
          capabilityRevision: 1,
          observationRevision: 2,
        },
      },
    });
    expect(actResponse.ok).toBe(true);
    receiptFaults.hit("receipt-delivery");
    broker.respond(socket, "host-conformance", generation, actResponse, actDispatch.target);
    const actPayload = await (await actCall).json() as { result: { content: [{ text: string }] } };
    const actObserved = JSON.parse(actPayload.result.content[0].text) as {
      operation: string;
      outcome: string;
      effect: string;
      recovery: string;
      receipts: Array<{ index: number; status: string; operation: string }>;
    };
    expect(actObserved.operation).toBe("act");
    expect(actObserved.receipts.map((receipt) => receipt.status)).toEqual(["applied", "interrupted", "skipped"]);
    const actNormalized = normalizeBrowserConformanceRun({
      receipts: actObserved.receipts.map((receipt) => ({
        order: { tick: 0, ordinal: receipt.index },
        operation: receipt.operation,
        status: receipt.status,
        effect: actObserved.effect,
        recovery: actObserved.recovery,
      })),
      outcome: {
        status: actObserved.outcome,
        effect: actObserved.effect,
        recovery: actObserved.recovery,
      },
      finalState: { readiness: "ready", resources: scenario.cleanup.baseline },
    });
    expect(actNormalized.outcome.status).toBe("interrupted");
    expect(actNormalized.outcome.effect).toBe("partial");
    expect(actNormalized.outcome.recovery).toBe("inspect");
    expect(actNormalized.receipts.map((receipt) => receipt.status)).toEqual(["applied", "interrupted", "skipped"]);
    expect(actNormalized.receipts.some((receipt) => receipt.status === "unknown" || receipt.operation === "unknown")).toBe(false);

    race.event("host-disconnect");
    cleanupFaults.hit("cleanup");
    broker.disconnect(socket);
    expect(broker.status()).toEqual({ hosts: 0, pending: 0, assignments: 0 });
    expect(broker.reliabilityStatus().succeeded).toBe(baselineReliability.succeeded + 2);
    expect(() => broker.respond(socket, "host-conformance", generation, response, dispatch!.target))
      .toThrow("stale or invalid");
    race.event("late-event");
    race.assertComplete();
    expect(broker.status()).toEqual({ hosts: 0, pending: 0, assignments: 0 });
    expect(credentials.revoke(issued.credentialId)).toBe(true);
    expect(credentials.size()).toBe(0);
    expect(transportFaults.callsFor("host-transport")).toBe(2);
    expect(targetFaults.callsFor("target-registration")).toBe(1);
    expect(receiptFaults.callsFor("receipt-delivery")).toBe(2);
    expect(cleanupFaults.callsFor("cleanup")).toBe(1);
    transportFaults.dispose();
    targetFaults.dispose();
    receiptFaults.dispose();
    cleanupFaults.dispose();
    expect(transportFaults.isDisposed).toBe(true);
    expect(targetFaults.isDisposed).toBe(true);
    expect(receiptFaults.isDisposed).toBe(true);
    expect(cleanupFaults.isDisposed).toBe(true);
  });
});
