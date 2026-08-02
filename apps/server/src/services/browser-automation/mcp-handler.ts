import { randomUUID } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import {
  BROWSER_AUTOMATION_CONTRACT_VERSION,
  BROWSER_AUTOMATION_MAX_RESULT_BYTES,
  BROWSER_AUTOMATION_OPERATION_METADATA,
  BROWSER_AUTOMATION_OPERATIONS,
  BrowserAutomationRequestSchema,
  type BrowserAutomationOperation,
} from "@mcode/contracts";
import type { BrowserAutomationBroker } from "./broker.js";
import type {
  BrowserAutomationCredentialClaims,
  BrowserAutomationCredentialRegistry,
} from "./credential-registry.js";

const MAX_BODY_BYTES = 256 * 1_024;
const MCP_PROTOCOL_VERSIONS = ["2025-03-26", "2024-11-05"] as const;
const TOOL_NAME_TO_OPERATION = new Map<string, BrowserAutomationOperation>(
  [["browser_inspect", "inspect" as BrowserAutomationOperation] as const, ...BROWSER_AUTOMATION_OPERATIONS.map((operation) => [
    BROWSER_AUTOMATION_OPERATION_METADATA[operation].mcpName,
    operation,
  ] as const)]),
);

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
  expectedControlEpoch: { type: "integer", minimum: 0, description: "Control epoch returned by browser_status." },
} as const;

function inputSchema(operation: BrowserAutomationOperation): Record<string, unknown> {
  const schemas: Record<BrowserAutomationOperation, Record<string, unknown>> = {
    inspect: { includeScreenshot: { type: "boolean", default: false }, includeDiagnostics: { type: "boolean", default: false } },
    status: {},
    open: {
      url: { type: "string", format: "uri" },
      idempotencyKey: { type: "string", minLength: 1, maxLength: 256 },
    },
    navigate: { url: { type: "string", format: "uri" } },
    resize: { width: { type: "integer", minimum: 320, maximum: 7680 }, height: { type: "integer", minimum: 240, maximum: 4320 } },
    snapshot: { includeScreenshot: { type: "boolean", default: true }, timeoutMs: { type: "integer", minimum: 1, maximum: 60000 } },
    screenshot: { maxWidth: { type: "integer", minimum: 1, maximum: 1280 }, fullPage: { type: "boolean", default: false } },
    click: { target: { type: "object", description: "Exactly one of semanticId, role plus accessibleName, cssSelector, or x plus y." }, button: { enum: ["left", "middle", "right"] }, clickCount: { type: "integer", minimum: 1, maximum: 3 }, timeoutMs: { type: "integer", minimum: 1, maximum: 60000 } },
    type: { target: { type: "object" }, text: { type: "string", maxLength: 16384 }, clear: { type: "boolean" }, submit: { type: "boolean" }, timeoutMs: { type: "integer", minimum: 1, maximum: 60000 } },
    press: { key: { type: "string", minLength: 1, maxLength: 64 }, modifiers: { type: "array", items: { enum: ["Alt", "Control", "Meta", "Shift"] }, maxItems: 4 }, timeoutMs: { type: "integer", minimum: 1, maximum: 60000 } },
    scroll: { target: { type: "object" }, deltaX: { type: "number", minimum: -100000, maximum: 100000 }, deltaY: { type: "number", minimum: -100000, maximum: 100000 }, timeoutMs: { type: "integer", minimum: 1, maximum: 60000 } },
    waitFor: { target: { type: "object" }, url: { type: "string", format: "uri" }, text: { type: "string" }, state: { enum: ["attached", "visible", "hidden", "detached"] }, timeoutMs: { type: "integer", minimum: 1, maximum: 60000 } },
    console: { levels: { type: "array", items: { enum: ["debug", "info", "warning", "error"] }, maxItems: 4 }, source: { type: "string", minLength: 1, maxLength: 2048 }, limit: { type: "integer", minimum: 1, maximum: 200 } },
    network: { failedOnly: { type: "boolean" }, limit: { type: "integer", minimum: 1, maximum: 200 } },
    accessibility: { root: { type: "object" }, limit: { type: "integer", minimum: 1, maximum: 1000 } },
    performance: { includeMemory: { type: "boolean" } },
    evaluate: { expression: { type: "string", minLength: 1, maxLength: 65536 }, awaitPromise: { type: "boolean" }, timeoutMs: { type: "integer", minimum: 1, maximum: 60000 } },
    recordingStart: { maxDurationMs: { type: "integer", minimum: 1000, maximum: 600000 } },
    recordingStop: {},
  };
  const requiredByOperation: Partial<Record<BrowserAutomationOperation, string[]>> = {
    open: ["idempotencyKey"], navigate: ["url"], resize: ["width", "height"], click: ["target"], type: ["text"], press: ["key"], scroll: ["deltaY"], evaluate: ["expression"],
  };
  return {
    type: "object",
    properties: { ...commonProperties, ...schemas[operation] },
    required: requiredByOperation[operation] ?? [],
    additionalProperties: false,
  };
}

function toolList(operations: readonly BrowserAutomationOperation[]): Array<Record<string, unknown>> {
  return operations.map((operation) => {
    const metadata = BROWSER_AUTOMATION_OPERATION_METADATA[operation];
    return {
      name: metadata.mcpName,
      description: `Operate or inspect the user-visible Mcode Browser: ${operation}.`,
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
      return { jsonrpc: "2.0", id, result: { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "mcode-browser", version: String(BROWSER_AUTOMATION_CONTRACT_VERSION) } } };
    }
    if (request.method === "tools/list") {
      return { jsonrpc: "2.0", id, result: { tools: toolList(claims.allowedOperations) } };
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
    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: JSON.stringify(result.ok ? result.result : result.error) }],
        isError: !result.ok,
      },
    };
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
