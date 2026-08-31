import * as NodeHTTP from "node:http";
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
import { BrowserAutomationBroker } from "../../execution/broker.js";
import { BrowserAutomationCredentialRegistry } from "../../access/credential-registry.js";
import { BrowserAutomationMcpHandler } from "../mcp-handler.js";

const socket = { name: "conformance-host" } as never;

let server: NodeHTTP.Server | undefined;
let broker: BrowserAutomationBroker | undefined;
let credentials: BrowserAutomationCredentialRegistry | undefined;

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

interface McpConformanceFixture {
  readonly race: ReturnType<typeof mcpRaceDriver>;
  readonly transportFaults: BrowserConformanceFaultController;
  readonly targetFaults: BrowserConformanceFaultController;
  readonly receiptFaults: BrowserConformanceFaultController;
  readonly cleanupFaults: BrowserConformanceFaultController;
  readonly baselineReliability: ReturnType<BrowserAutomationBroker["reliabilityStatus"]>;
  readonly generation: number;
  readonly issued: ReturnType<BrowserAutomationCredentialRegistry["issue"]>;
  readonly scenario: ReturnType<typeof createBrowserConformanceScenario>;
  readonly endpoint: string;
  readonly nextDispatch: () => Promise<BrowserAutomationHostDispatch>;
}

function createDispatchQueue(transportFaults: BrowserConformanceFaultController): {
  readonly nextDispatch: () => Promise<BrowserAutomationHostDispatch>;
  readonly record: (channel: string, data: unknown) => boolean;
} {
  const resolvers: Array<(value: BrowserAutomationHostDispatch) => void> = [];
  return {
    nextDispatch: () => new Promise((resolve) => {
      resolvers.push(resolve);
    }),
    record: (channel, data) => {
      transportFaults.hit("host-transport");
      if (channel === "browserAutomation.request") {
        resolvers.shift()?.((data as { dispatch: BrowserAutomationHostDispatch }).dispatch);
      }
      return true;
    },
  };
}

function createMcpConformanceScenario() {
  return createBrowserConformanceScenario({
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
}

async function startMcpConformanceServer(handler: BrowserAutomationMcpHandler): Promise<string> {
  server = NodeHTTP.createServer((req, res) => void handler.handle(req, res));
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("conformance server did not bind");
  return `http://127.0.0.1:${address.port}/mcp`;
}

async function createMcpConformanceFixture(): Promise<McpConformanceFixture> {
  const race = mcpRaceDriver();
  const transportFaults = new BrowserConformanceFaultController();
  const targetFaults = new BrowserConformanceFaultController();
  const receiptFaults = new BrowserConformanceFaultController();
  const cleanupFaults = new BrowserConformanceFaultController();
  const dispatchQueue = createDispatchQueue(transportFaults);
  credentials = new BrowserAutomationCredentialRegistry({ now: () => 1_000 });
  broker = new BrowserAutomationBroker({
    now: () => 1_000,
    send: (_socket, channel, data) => dispatchQueue.record(channel, data),
  });
  const activeBroker = broker;
  const activeCredentials = credentials;
  const baselineReliability = activeBroker.reliabilityStatus();
  const registered = activeBroker.registerHost(socket, registration(), {
    desktopInstanceId: "desktop-conformance",
    worktreeIdentity: "worktree-conformance",
    allowedWorkspaceIds: ["workspace-conformance"],
  });
  const generation = registered.generation;
  targetFaults.hit("target-registration");
  activeBroker.updateTargets(socket, "host-conformance", generation, [target(generation)]);
  const issued = activeCredentials.issue({
    providerId: "codex",
    providerSessionId: "provider-conformance",
    mcodeSessionId: "mcode-conformance",
    threadId: "thread-conformance",
    workspaceId: "workspace-conformance",
    worktreeIdentity: "worktree-conformance",
    permissionCapability: "interact",
    allowedOperations: ["inspect", "act"],
  });
  const handler = new BrowserAutomationMcpHandler({
    credentials: activeCredentials,
    broker: activeBroker,
    now: () => 1_000,
  });
  return {
    race,
    transportFaults,
    targetFaults,
    receiptFaults,
    cleanupFaults,
    baselineReliability,
    generation,
    issued,
    scenario: createMcpConformanceScenario(),
    endpoint: await startMcpConformanceServer(handler),
    nextDispatch: dispatchQueue.nextDispatch,
  };
}

function callMcpTool(
  fixture: McpConformanceFixture,
  id: number,
  operation: string,
  args: unknown,
): Promise<Response> {
  return fetch(fixture.endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${fixture.issued.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: `browser_${operation}`, arguments: args ?? {} },
    }),
  });
}

function createInspectionResponse(dispatch: BrowserAutomationHostDispatch): BrowserAutomationResponse {
  return BrowserAutomationResponseSchema().parse({
    contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
    requestId: dispatch.request.requestId,
    sequence: dispatch.request.sequence,
    ok: true,
    result: {
      operation: "inspect", tabs: [], capabilities: ["inspect", "act"], observationRef: "observation-conformance-1",
    },
  });
}

function createActResponse(dispatch: BrowserAutomationHostDispatch): BrowserAutomationResponse {
  return BrowserAutomationResponseSchema().parse({
    contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
    requestId: dispatch.request.requestId,
    sequence: dispatch.request.sequence,
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
}

async function readMcpPayload(response: Response): Promise<{ result: { content: [{ text: string }] } }> {
  return response.json() as Promise<{ result: { content: [{ text: string }] } }>;
}

async function runInspection(fixture: McpConformanceFixture): Promise<{
  readonly dispatch: BrowserAutomationHostDispatch;
  readonly response: BrowserAutomationResponse;
  readonly payload: { result: { content: [{ text: string }] } };
}> {
  const command = fixture.scenario.commands[0]!;
  const dispatchReady = fixture.nextDispatch();
  const call = callMcpTool(fixture, 1, command.operation, command.args);
  const dispatch = await dispatchReady;
  const response = createInspectionResponse(dispatch);
  fixture.receiptFaults.hit("receipt-delivery");
  broker!.respond(socket, "host-conformance", fixture.generation, response, dispatch.target);
  return { dispatch, response, payload: await readMcpPayload(await call) };
}

function assertInspectionConformance(
  fixture: McpConformanceFixture,
  inspection: Awaited<ReturnType<typeof runInspection>>,
): void {
  expect(inspection.response.ok).toBe(true);
  if (!inspection.response.ok) throw new Error("inspection response must succeed");
  const observed = JSON.parse(inspection.payload.result.content[0].text) as {
    operation: string;
    capabilities: string[];
  };
  const normalized = normalizeBrowserConformanceRun({
    receipts: [{
      operation: inspection.response.result.operation,
      status: "satisfied",
      effect: "none",
      recovery: "none",
      errorCode: null,
    }],
    outcome: { status: "completed", effect: "none", recovery: "none", errorCode: null },
    finalState: { readiness: "ready", resources: fixture.scenario.cleanup.baseline },
  });
  expect(observed.operation).toBe(inspection.response.result.operation);
  expect(normalized.outcome.status).toBe("completed");
  expect(normalized.outcome.effect).toBe("none");
  expect(normalized.outcome.recovery).toBe("none");
  expect(normalized.receipts.some((receipt) => receipt.status === "unknown" || receipt.operation === "unknown")).toBe(false);
  expect(JSON.parse(inspection.payload.result.content[0].text))
    .toMatchObject({ operation: "inspect", capabilities: ["inspect", "act"] });
}

async function runAct(fixture: McpConformanceFixture): Promise<{
  readonly dispatch: BrowserAutomationHostDispatch;
  readonly response: BrowserAutomationResponse;
  readonly payload: { result: { content: [{ text: string }] } };
}> {
  const command = fixture.scenario.commands[1]!;
  const dispatchReady = fixture.nextDispatch();
  const call = callMcpTool(fixture, 2, command.operation, command.args);
  const dispatch = await dispatchReady;
  const scenarioArgs = command.args as { steps: readonly { operation: string }[] };
  expect(dispatch.request.operation).toBe("act");
  expect(dispatch.request.args.steps).toHaveLength(scenarioArgs.steps.length);
  expect(dispatch.request.args.steps.map((step: { operation: string }) => step.operation))
    .toEqual(scenarioArgs.steps.map((step) => step.operation));
  const response = createActResponse(dispatch);
  fixture.receiptFaults.hit("receipt-delivery");
  broker!.respond(socket, "host-conformance", fixture.generation, response, dispatch.target);
  return { dispatch, response, payload: await readMcpPayload(await call) };
}

function assertActConformance(
  fixture: McpConformanceFixture,
  act: Awaited<ReturnType<typeof runAct>>,
): void {
  expect(act.response.ok).toBe(true);
  if (!act.response.ok) throw new Error("act response must succeed");
  const observed = JSON.parse(act.payload.result.content[0].text) as {
    operation: string;
    outcome: string;
    effect: string;
    recovery: string;
    receipts: Array<{ index: number; status: string; operation: string }>;
  };
  const normalized = normalizeBrowserConformanceRun({
    receipts: observed.receipts.map((receipt) => ({
      order: { tick: 0, ordinal: receipt.index },
      operation: receipt.operation,
      status: receipt.status,
      effect: observed.effect,
      recovery: observed.recovery,
    })),
    outcome: { status: observed.outcome, effect: observed.effect, recovery: observed.recovery },
    finalState: { readiness: "ready", resources: fixture.scenario.cleanup.baseline },
  });
  expect(observed.operation).toBe("act");
  expect(observed.receipts.map((receipt) => receipt.status)).toEqual(["applied", "interrupted", "skipped"]);
  expect(normalized.outcome.status).toBe("interrupted");
  expect(normalized.outcome.effect).toBe("partial");
  expect(normalized.outcome.recovery).toBe("inspect");
  expect(normalized.receipts.map((receipt) => receipt.status)).toEqual(["applied", "interrupted", "skipped"]);
  expect(normalized.receipts.some((receipt) => receipt.status === "unknown" || receipt.operation === "unknown")).toBe(false);
}

function assertMcpConformanceCleanup(
  fixture: McpConformanceFixture,
  inspection: Awaited<ReturnType<typeof runInspection>>,
): void {
  fixture.race.event("host-disconnect");
  fixture.cleanupFaults.hit("cleanup");
  broker!.disconnect(socket);
  expect(broker!.status()).toEqual({ hosts: 0, pending: 0, assignments: 0 });
  expect(broker!.reliabilityStatus().succeeded).toBe(fixture.baselineReliability.succeeded + 2);
  expect(() => broker!.respond(socket, "host-conformance", fixture.generation, inspection.response, inspection.dispatch.target))
    .toThrow("stale or invalid");
  fixture.race.event("late-event");
  fixture.race.assertComplete();
  expect(broker!.status()).toEqual({ hosts: 0, pending: 0, assignments: 0 });
  expect(credentials!.revoke(fixture.issued.credentialId)).toBe(true);
  expect(credentials!.size()).toBe(0);
  expect(fixture.transportFaults.callsFor("host-transport")).toBe(2);
  expect(fixture.targetFaults.callsFor("target-registration")).toBe(1);
  expect(fixture.receiptFaults.callsFor("receipt-delivery")).toBe(2);
  expect(fixture.cleanupFaults.callsFor("cleanup")).toBe(1);
  fixture.transportFaults.dispose();
  fixture.targetFaults.dispose();
  fixture.receiptFaults.dispose();
  fixture.cleanupFaults.dispose();
  expect(fixture.transportFaults.isDisposed).toBe(true);
  expect(fixture.targetFaults.isDisposed).toBe(true);
  expect(fixture.receiptFaults.isDisposed).toBe(true);
  expect(fixture.cleanupFaults.isDisposed).toBe(true);
}

describe("authenticated Browser MCP conformance", () => {
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
    const fixture = await createMcpConformanceFixture();
    const inspection = await runInspection(fixture);
    assertInspectionConformance(fixture, inspection);
    assertActConformance(fixture, await runAct(fixture));
    assertMcpConformanceCleanup(fixture, inspection);
  });
});
