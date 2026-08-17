import { randomUUID } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import {
  BROWSER_AUTOMATION_CONTRACT_VERSION,
  BROWSER_AUTOMATION_MAX_RESULT_BYTES,
  BROWSER_AUTOMATION_OPERATION_METADATA,
  BROWSER_V2_CORE_OPERATIONS,
  BrowserAutomationRequestSchema,
  type BrowserAutomationResult,
  type BrowserAutomationPublicOperation,
  type BrowserAutomationResponse,
} from "@mcode/contracts";
import { MCODE_BROWSER_GUIDE } from "@mcode/thread-orchestration";
import type { BrowserAutomationBroker } from "../execution/broker.js";
import type {
  BrowserAutomationCredentialClaims,
  BrowserAutomationCredentialRegistry,
} from "../access/credential-registry.js";

const MAX_BODY_BYTES = 256 * 1_024;
const MCP_PROTOCOL_VERSIONS = ["2025-03-26", "2024-11-05"] as const;
const TOOL_NAME_TO_OPERATION = new Map<string, BrowserAutomationPublicOperation>([
  ...[...BROWSER_V2_CORE_OPERATIONS, "evaluate" as const].map((operation) => [
    BROWSER_AUTOMATION_OPERATION_METADATA[operation].mcpName,
    operation,
  ] as const),
]);

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

interface ActiveMcpCall {
  claims: BrowserAutomationCredentialClaims;
  requestId: string;
  sequence: number;
}

/** Dependencies for the strict loopback browser MCP endpoint. */
export interface BrowserAutomationMcpHandlerOptions {
  credentials: BrowserAutomationCredentialRegistry;
  broker: BrowserAutomationBroker;
  now?: () => number;
  maxSequenceEntries?: number;
  sequenceTtlMs?: number;
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function bearerToken(req: IncomingMessage): string | null {
  const value = req.headers.authorization;
  if (typeof value !== "string") return null;
  const match = /^Bearer ([A-Za-z0-9_-]{20,256})$/.exec(value);
  return match?.[1] ?? null;
}

function jsonRpcError(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBoundedBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new RangeError("request-too-large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size);
}

function parseJsonRpc(value: unknown): JsonRpcRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const request = value as Record<string, unknown>;
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") return null;
  if (
    request.id !== undefined &&
    request.id !== null &&
    typeof request.id !== "string" &&
    typeof request.id !== "number"
  ) {
    return null;
  }
  return request as unknown as JsonRpcRequest;
}

const commonProperties = {
  expectedControlEpoch: { type: "integer", minimum: 0, description: "Control epoch returned by browser_inspect." },
} as const;

const actTargetSchema = {
  oneOf: [
    { type: "object", properties: { semanticId: { type: "string", minLength: 1, maxLength: 1_024 } }, required: ["semanticId"], additionalProperties: false },
    { type: "object", properties: { role: { type: "string", minLength: 1, maxLength: 128 }, accessibleName: { type: "string", minLength: 1, maxLength: 1_024 } }, required: ["role", "accessibleName"], additionalProperties: false },
    { type: "object", properties: { cssSelector: { type: "string", minLength: 1, maxLength: 4_096 } }, required: ["cssSelector"], additionalProperties: false },
    { type: "object", properties: { x: { type: "number", minimum: 0, maximum: 100_000 }, y: { type: "number", minimum: 0, maximum: 100_000 } }, required: ["x", "y"], additionalProperties: false },
  ],
} as const;

const actTimeoutSchema = { type: "integer", minimum: 1, maximum: 60_000 } as const;

function actStepSchema(
  operation: string,
  properties: Record<string, unknown>,
  required: readonly string[] = [],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "object",
    properties: { operation: { const: operation }, ...properties },
    required: ["operation", ...required],
    additionalProperties: false,
    ...extra,
  };
}

const actStepVariants = [
  actStepSchema("navigate", { url: { type: "string", format: "uri", minLength: 1, maxLength: 2_048 } }, ["url"]),
  actStepSchema("back", {}),
  actStepSchema("forward", {}),
  actStepSchema("reload", {}),
  actStepSchema("resize", { width: { type: "integer", minimum: 320, maximum: 7_680 }, height: { type: "integer", minimum: 240, maximum: 4_320 } }, ["width", "height"]),
  actStepSchema("hover", { target: actTargetSchema, timeoutMs: actTimeoutSchema }, ["target"]),
  actStepSchema("click", { target: actTargetSchema, button: { enum: ["left", "middle", "right"], default: "left" }, clickCount: { enum: [1, 2], default: 1 }, timeoutMs: actTimeoutSchema }, ["target"]),
  actStepSchema("drag", { source: actTargetSchema, target: actTargetSchema, timeoutMs: actTimeoutSchema }, ["source", "target"]),
  actStepSchema("type", { target: actTargetSchema, text: { type: "string", maxLength: 16_384 }, clear: { type: "boolean", default: false }, submit: { type: "boolean", default: false }, timeoutMs: actTimeoutSchema }, ["text"]),
  actStepSchema("press", { key: { type: "string", minLength: 1, maxLength: 64 }, modifiers: { type: "array", items: { enum: ["Alt", "Control", "Meta", "Shift"] }, maxItems: 4, default: [] }, timeoutMs: actTimeoutSchema }, ["key"]),
  actStepSchema("scroll", { target: actTargetSchema, deltaX: { type: "number", minimum: -100_000, maximum: 100_000, default: 0 }, deltaY: { type: "number", minimum: -100_000, maximum: 100_000 }, timeoutMs: actTimeoutSchema }, ["deltaY"]),
  actStepSchema("wait", { durationMs: { type: "integer", minimum: 1, maximum: 60_000 } }, ["durationMs"]),
  actStepSchema("assert", { target: actTargetSchema, text: { type: "string", minLength: 1, maxLength: 1_024 }, url: { type: "string", format: "uri", minLength: 1, maxLength: 2_048 } }, [], { anyOf: [{ required: ["target"] }, { required: ["text"] }, { required: ["url"] }] }),
  actStepSchema("recordingStart", {}),
  actStepSchema("recordingStop", {}),
];

const tabsMutationProperties = {
  idempotencyKey: { type: "string", minLength: 1, maxLength: 256 },
  observationRef: { type: "string", minLength: 1, maxLength: 256 },
  ...commonProperties,
} as const;

/** Describes Browser tab actions without a top-level JSON Schema union. */
const tabsInputSchema = {
  type: "object",
  properties: {
    ...tabsMutationProperties,
    action: {
      enum: ["select", "claim", "release", "close", "finalize"],
      description: "Select or claim requires tabId; finalize requires dispositions; release and close may omit tabId.",
    },
    tabId: { type: "string", minLength: 1, maxLength: 256 },
    dispositions: {
      type: "array",
      maxItems: 32,
      items: {
        type: "object",
        properties: {
          tabId: { type: "string", minLength: 1, maxLength: 256 },
          disposition: { enum: ["close", "release", "handoff", "deliverable"] },
        },
        required: ["tabId", "disposition"],
        additionalProperties: false,
      },
    },
  },
  required: ["action", "idempotencyKey", "observationRef"],
  additionalProperties: false,
} satisfies Record<string, unknown>;

function inputSchema(operation: BrowserAutomationPublicOperation): Record<string, unknown> {
  const schemas: Record<BrowserAutomationPublicOperation, Record<string, unknown>> = {
    inspect: { includeScreenshot: { type: "boolean", default: false }, includeDiagnostics: { type: "boolean", default: false } },
    act: {
      idempotencyKey: { type: "string", minLength: 1, maxLength: 256 },
      observationRef: { type: "string", minLength: 1, maxLength: 256 },
      deadlineMs: { type: "integer", minimum: 1, maximum: 60000 },
      steps: { type: "array", minItems: 1, maxItems: 8, items: { oneOf: actStepVariants } },
    },
    open: {
      url: { type: "string", format: "uri" },
      idempotencyKey: { type: "string", minLength: 1, maxLength: 256 },
    },
    evaluate: {
      idempotencyKey: { type: "string", minLength: 1, maxLength: 256 },
      observationRef: { type: "string", minLength: 1, maxLength: 256 },
      deadlineMs: { type: "integer", minimum: 1, maximum: 60000 },
      expression: { type: "string", minLength: 1, maxLength: 65536 },
      awaitPromise: { type: "boolean" },
      timeoutMs: { type: "integer", minimum: 1, maximum: 60000 },
    },
    tabs: tabsInputSchema,
  };
  const requiredByOperation: Partial<Record<BrowserAutomationPublicOperation, string[]>> = {
    open: ["idempotencyKey"], act: ["idempotencyKey", "observationRef", "deadlineMs", "steps"], evaluate: ["idempotencyKey", "observationRef", "deadlineMs", "expression"],
  };
  if (operation === "tabs") return tabsInputSchema;
  return {
    type: "object",
    properties: { ...commonProperties, ...schemas[operation] },
    required: requiredByOperation[operation] ?? [],
    additionalProperties: false,
  };
}

function toolDescription(operation: BrowserAutomationPublicOperation): string {
  switch (operation) {
    case "open":
      return "Create one agent-owned background tab and return its initial Browser observation. Use a fresh idempotency key; this does not reveal or focus the Browser panel.";
    case "inspect":
      return "Inspect Browser readiness and return the canonical session-specific capabilities, constraints, tabs, observationRef, diagnostics, and recovery guidance.";
    case "act":
      return "Execute up to eight ordered Browser steps against the latest observationRef. Use a fresh idempotency key and stop at any failure, interruption, deadline, navigation, or invalidation boundary.";
    case "tabs":
      return "Select, claim, release, close, or finalize Browser tabs using the latest observationRef and a fresh idempotency key. Release claimed user tabs instead of closing them.";
    case "evaluate":
      return "Run privileged open-world page evaluation only when live negotiation advertises this tool. Use the same observationRef, idempotency, interruption, receipt, effect, and recovery rules as Browser mutations.";
    default:
      return `Operate or inspect the user-visible Mcode Browser: ${operation}. Follow Browser readiness and recovery results before another call.`;
  }
}

function toolList(operations: readonly BrowserAutomationPublicOperation[]): Array<Record<string, unknown>> {
  return operations.map((operation) => {
    const metadata = BROWSER_AUTOMATION_OPERATION_METADATA[operation];
    return {
      name: metadata.mcpName,
      description: toolDescription(operation),
      inputSchema: inputSchema(operation),
      annotations: {
        readOnlyHint: metadata.annotations.readOnly,
        destructiveHint: metadata.annotations.destructive,
        idempotentHint: metadata.annotations.idempotent,
        openWorldHint: metadata.annotations.openWorld,
      },
    };
  });
}

type BrowserAutomationScreenshot = NonNullable<Extract<BrowserAutomationResult, { operation: "inspect" }>["screenshot"]>;

function screenshotProjection(screenshot: BrowserAutomationScreenshot): {
  readonly data: string;
  readonly metadata: Omit<BrowserAutomationScreenshot, "dataBase64">;
  readonly mimeType: BrowserAutomationScreenshot["mediaType"];
} {
  const { dataBase64, ...metadata } = screenshot;
  return { data: dataBase64, metadata, mimeType: screenshot.mediaType };
}

function screenshotFromResult(
  result: BrowserAutomationResult,
): BrowserAutomationScreenshot | undefined {
  switch (result.operation) {
    case "inspect":
      return result.screenshot;
    default:
      return undefined;
  }
}

function mcpContent(result: BrowserAutomationResponse): Array<Record<string, unknown>> {
  if (!result.ok) return [{ type: "text", text: JSON.stringify(result.error) }];

  const toolResult = result.result;
  const screenshot = screenshotFromResult(toolResult);
  if (!screenshot) return [{ type: "text", text: JSON.stringify(toolResult) }];

  const projection = screenshotProjection(screenshot);
  const metadataResult = { ...toolResult, screenshot: projection.metadata };
  return [
    { type: "text", text: JSON.stringify(metadataResult) },
    { type: "image", data: projection.data, mimeType: projection.mimeType },
  ];
}

/** Handles authenticated, stateless JSON-RPC calls for visible-browser MCP tools. */
export class BrowserAutomationMcpHandler {
  private readonly credentials: BrowserAutomationCredentialRegistry;
  private readonly broker: BrowserAutomationBroker;
  private readonly now: () => number;
  private readonly sequences = new Map<string, { sequence: number; lastUsedAt: number }>();
  private readonly activeCalls = new Map<string, ActiveMcpCall>();
  private readonly maxSequenceEntries: number;
  private readonly sequenceTtlMs: number;

  constructor(options: BrowserAutomationMcpHandlerOptions) {
    this.credentials = options.credentials;
    this.broker = options.broker;
    this.now = options.now ?? Date.now;
    this.maxSequenceEntries = options.maxSequenceEntries ?? 256;
    this.sequenceTtlMs = options.sequenceTtlMs ?? 30 * 60_000;
    if (!Number.isInteger(this.maxSequenceEntries) || this.maxSequenceEntries < 1 || this.maxSequenceEntries > 4_096) {
      throw new Error("Browser MCP sequence capacity is invalid");
    }
    if (!Number.isInteger(this.sequenceTtlMs) || this.sequenceTtlMs < 1_000 || this.sequenceTtlMs > 24 * 60 * 60_000) {
      throw new Error("Browser MCP sequence TTL is invalid");
    }
  }

  /** Releases per-credential sequence state when a credential is revoked. */
  releaseCredential(credentialId: string): boolean {
    let removed = this.sequences.delete(credentialId);
    for (const [key, call] of this.activeCalls) {
      if (call.claims.credentialId !== credentialId) continue;
      this.activeCalls.delete(key);
      removed = true;
    }
    return removed;
  }

  /** Prunes expired per-credential sequence state at an explicit lifecycle checkpoint. */
  sweep(): void {
    const now = this.now();
    for (const [credentialId, state] of this.sequences) {
      if (now - state.lastUsedAt >= this.sequenceTtlMs) this.sequences.delete(credentialId);
    }
  }

  /** Processes one HTTP request and returns true when the `/mcp` route matched. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname !== "/mcp") return false;
    if (!isLoopback(req.socket.remoteAddress)) {
      writeJson(res, 403, jsonRpcError(null, -32003, "Forbidden"));
      return true;
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      writeJson(res, 405, jsonRpcError(null, -32600, "Method not allowed"));
      return true;
    }
    const token = bearerToken(req);
    const claims = token ? this.credentials.authenticate(token) : null;
    if (!claims) {
      writeJson(res, 401, jsonRpcError(null, -32001, "Unauthorized"));
      return true;
    }

    let body: Buffer;
    try {
      body = await readBoundedBody(req);
    } catch (error) {
      if (error instanceof RangeError) {
        writeJson(res, 413, jsonRpcError(null, -32600, "Request body is too large"));
        return true;
      }
      throw error;
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(body.toString("utf8"));
    } catch {
      writeJson(res, 400, jsonRpcError(null, -32700, "Parse error"));
      return true;
    }
    const request = parseJsonRpc(decoded);
    if (!request) {
      writeJson(res, 400, jsonRpcError(null, -32600, "Invalid Request"));
      return true;
    }

    if (request.id === undefined && request.method === "notifications/initialized") {
      res.writeHead(202, { "Cache-Control": "no-store" });
      res.end();
      return true;
    }

    const cancellableId = request.id !== undefined && request.id !== null ? request.id : null;
    const cancelOnDisconnect = (): void => {
      if (!res.writableEnded && cancellableId !== null) {
        this.cancelActiveCall(claims, cancellableId);
      }
    };
    res.once("close", cancelOnDisconnect);
    let response: Record<string, unknown>;
    try {
      response = await this.dispatch(request, claims);
    } finally {
      res.off("close", cancelOnDisconnect);
    }
    if (request.id === undefined && request.method === "notifications/cancelled") {
      res.writeHead(202, { "Cache-Control": "no-store" });
      res.end();
      return true;
    }
    const encoded = JSON.stringify(response);
    if (Buffer.byteLength(encoded) > BROWSER_AUTOMATION_MAX_RESULT_BYTES) {
      writeJson(res, 200, jsonRpcError(request.id ?? null, -32002, "Browser result exceeds the response limit"));
      return true;
    }
    writeJson(res, 200, response);
    return true;
  }

  private async dispatch(
    request: JsonRpcRequest,
    claims: BrowserAutomationCredentialClaims,
  ): Promise<Record<string, unknown>> {
    const id = request.id ?? null;
    if (request.method === "initialize") {
      const requested = request.params && typeof request.params === "object" && !Array.isArray(request.params)
        ? (request.params as Record<string, unknown>).protocolVersion
        : undefined;
      const protocolVersion = typeof requested === "string" && MCP_PROTOCOL_VERSIONS.includes(requested as (typeof MCP_PROTOCOL_VERSIONS)[number])
        ? requested
        : MCP_PROTOCOL_VERSIONS[0];
      const browserV2Granted = claims.allowedOperations.includes("inspect");
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "mcode-browser", version: String(BROWSER_AUTOMATION_CONTRACT_VERSION) },
          ...(browserV2Granted ? { instructions: MCODE_BROWSER_GUIDE } : {}),
        },
      };
    }
    if (request.method === "tools/list") {
      return { jsonrpc: "2.0", id, result: { tools: toolList(this.discoverableOperations(claims)) } };
    }
    if (request.method === "notifications/cancelled") {
      const cancelledId = request.params && typeof request.params === "object" && !Array.isArray(request.params)
        ? (request.params as Record<string, unknown>).requestId
        : undefined;
      if (typeof cancelledId !== "string" && typeof cancelledId !== "number") {
        return jsonRpcError(id, -32602, "Invalid cancellation request");
      }
      this.cancelActiveCall(claims, cancelledId);
      return { jsonrpc: "2.0", id, result: {} };
    }
    if (request.method !== "tools/call") return jsonRpcError(id, -32601, "Method not found");
    if (request.id === undefined || request.id === null) {
      return jsonRpcError(id, -32600, "Browser tool calls require a request id");
    }
    if (!request.params || typeof request.params !== "object" || Array.isArray(request.params)) {
      return jsonRpcError(id, -32602, "Invalid params");
    }
    const params = request.params as Record<string, unknown>;
    if (typeof params.name !== "string" || (params.arguments !== undefined && (typeof params.arguments !== "object" || params.arguments === null || Array.isArray(params.arguments)))) {
      return jsonRpcError(id, -32602, "Invalid params");
    }
    const operation = TOOL_NAME_TO_OPERATION.get(params.name);
    if (!operation) return jsonRpcError(id, -32602, "Unknown browser tool");
    if (!claims.allowedOperations.includes(operation)) {
      return jsonRpcError(id, -32003, "Browser operation is forbidden");
    }
    if (operation === "evaluate" && claims.permissionCapability !== "privileged") {
      return jsonRpcError(id, -32003, "Browser evaluation is forbidden");
    }
    const values = { ...((params.arguments ?? {}) as Record<string, unknown>) };
    const expectedControlEpoch = typeof values.expectedControlEpoch === "number" ? values.expectedControlEpoch : 0;
    delete values.expectedControlEpoch;
    this.sweep();
    const sequence = (this.sequences.get(claims.credentialId)?.sequence ?? 0) + 1;
    if (!this.sequences.has(claims.credentialId)) {
      while (this.sequences.size >= this.maxSequenceEntries) this.evictOldestSequence();
    }
    this.sequences.set(claims.credentialId, { sequence, lastUsedAt: this.now() });
    const browserRequest = BrowserAutomationRequestSchema().safeParse({
      contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
      workspaceId: claims.workspaceId,
      threadId: claims.threadId,
      providerSessionId: claims.providerSessionId,
      providerInstanceId: claims.mcodeSessionId,
      requestId: randomUUID(),
      sequence,
      deadline: this.now() + 60_000,
      expectedControlEpoch,
      operation,
      args: values,
    });
    if (!browserRequest.success) return jsonRpcError(id, -32602, "Invalid browser tool arguments");
    const mcpStartedAt = this.now();
    this.broker.recordMcpLifecycle?.("mcp-routing", claims.providerId, browserRequest.data, {
      outcome: "accepted",
    });
    const activeKey = this.activeCallKey(claims.credentialId, request.id);
    if (this.activeCalls.has(activeKey)) {
      return jsonRpcError(id, -32600, "Browser tool request id is already active");
    }
    if (this.activeCalls.size >= this.maxSequenceEntries) {
      return jsonRpcError(id, -32004, "Browser tool call capacity is exhausted");
    }
    const activeCall: ActiveMcpCall = {
      claims,
      requestId: browserRequest.data.requestId,
      sequence: browserRequest.data.sequence,
    };
    this.activeCalls.set(activeKey, activeCall);
    let result: Awaited<ReturnType<BrowserAutomationBroker["execute"]>>;
    try {
      result = await this.broker.execute(claims, browserRequest.data);
    } finally {
      if (this.activeCalls.get(activeKey) === activeCall) this.activeCalls.delete(activeKey);
    }
    this.broker.recordMcpLifecycle?.("receipt-delivery", claims.providerId, browserRequest.data, {
      durationMs: Math.max(0, this.now() - mcpStartedAt),
      outcome: result.ok ? "completed" : "failed",
      settlement: result.ok || result.error.effect !== "unknown" ? "complete" : "unknown",
    });
    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: mcpContent(result),
        isError: !result.ok,
      },
    };
  }

  private discoverableOperations(
    claims: BrowserAutomationCredentialClaims,
  ): readonly BrowserAutomationPublicOperation[] {
    const negotiated = this.broker.availableOperations(claims);
    const core = BROWSER_V2_CORE_OPERATIONS.filter((operation) => claims.allowedOperations.includes(operation));
    return [
      ...core,
      ...negotiated.filter((operation) => !core.includes(operation as (typeof core)[number])),
    ];
  }

  private evictOldestSequence(): void {
    let oldest: [string, { sequence: number; lastUsedAt: number }] | undefined;
    for (const entry of this.sequences) {
      if (!oldest || entry[1].lastUsedAt < oldest[1].lastUsedAt) oldest = entry;
    }
    if (oldest) this.sequences.delete(oldest[0]);
  }

  private activeCallKey(credentialId: string, requestId: string | number): string {
    return JSON.stringify([credentialId, typeof requestId, requestId]);
  }

  private cancelActiveCall(
    claims: BrowserAutomationCredentialClaims,
    requestId: string | number,
  ): boolean {
    const key = this.activeCallKey(claims.credentialId, requestId);
    const active = this.activeCalls.get(key);
    if (!active) return false;
    this.activeCalls.delete(key);
    return this.broker.cancelFromProvider(active.claims, active.requestId, active.sequence);
  }
}
