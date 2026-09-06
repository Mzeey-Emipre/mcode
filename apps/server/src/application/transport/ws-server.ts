/**
 * HTTP + WebSocket server setup.
 * Creates an HTTP server for health checks and attachment serving,
 * and a WebSocket server on the same port for RPC + push events.
 */

import * as NodeHTTP from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { logger } from "@mcode/shared";
import { TerminalBackendError } from "../../features/terminal/backends/terminal-backend.js";
import { BinaryUploadHeaderSchema, TERMINAL_BINARY_MAGIC, type BinaryUploadHeader } from "@mcode/contracts";
import { routeMessage, type RouterDeps } from "./ws-router.js";
import { addClient, removeClient } from "./push.js";
import { handleBinaryUpload } from "../../features/attachments/transport/binary-upload.js";
import * as NodeCrypto from "node:crypto";
import { extractToken, buildAuthCookie } from "./auth.js";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { getMcodeDir } from "@mcode/shared";
import type {
  BrowserAutomationHostConnectionAuthorization,
  BrowserAutomationMcpHandler,
} from "../../features/browser-automation/index.js";
import { EXTERNAL_THREAD_CONTROL_MCP_PATH } from "../../features/thread-control/index.js";
import type { ReliabilityHarnessAdapter } from "../../runtime/reliability-harness/control.js";

/** Constant-time string comparison to prevent timing attacks on token validation. */
function safeTokenEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return NodeCrypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Match stored thread IDs used for the custom attachment protocol (UUID, lowercase hex). */
const ATTACHMENT_THREAD_SEGMENT = /^[a-f0-9-]+$/;
/** Filename is `{attachmentUuid}.{ext}` under the thread directory. */
const ATTACHMENT_FILE_SEGMENT = /^[a-f0-9-]+\.\w+$/;

/** Extension to MIME for persisted attachment files (aligned with desktop shell protocol). */
const ATTACHMENT_EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  rtf: "application/rtf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
};

export type WsServerDeps = RouterDeps & {
  authToken: string;
  singleInstance?: boolean;
  instanceToken?: string | null;
  worktreeIdentity?: string | null;
  shutdown: () => void;
  /** Handles the loopback-only browser MCP route when the feature is enabled. */
  browserAutomationMcpHandler?: BrowserAutomationMcpHandler;
  /** Optional opt-in packaged reliability controls. */
  reliabilityHarness?: ReliabilityHarnessAdapter;
};

/** Refreshes mutable workspace authorization while preserving one connection's desktop identity. */
export function refreshBrowserAutomationHostAuthorization(
  current: BrowserAutomationHostConnectionAuthorization | null,
  stableDesktopInstanceId: string | null,
): BrowserAutomationHostConnectionAuthorization | null {
  if (!current) return null;
  return {
    ...current,
    desktopInstanceId: stableDesktopInstanceId ?? current.desktopInstanceId,
    allowedWorkspaceIds: [...current.allowedWorkspaceIds],
  };
}

type InstanceCheckResult =
  | { ok: true }
  | { ok: false; code: "WRONG_INSTANCE"; expectedWorktree: string | null; presentedWorktree: string | null };

type InstanceAttachmentExpectation = Pick<WsServerDeps, "singleInstance" | "authToken" | "instanceToken" | "worktreeIdentity">;

interface WsMessageContext {
  readonly ws: WebSocket;
  readonly deps: WsServerDeps;
  readonly resolveCurrentBrowserAutomationAuthorization: () => BrowserAutomationHostConnectionAuthorization | null;
  pendingBinaryHeader: BinaryUploadHeader | null;
}

/** Query parameters used by browser clients to prove they target this dev instance. */
export const INSTANCE_TOKEN_QUERY_PARAM = "instanceToken";
export const WORKTREE_QUERY_PARAM = "worktree";

/** Validates the single-instance token and worktree identity from a WebSocket request. */
export function validateInstanceAttachment(
  req: NodeHTTP.IncomingMessage,
  expected: InstanceAttachmentExpectation,
): InstanceCheckResult {
  if (!expected.singleInstance) return { ok: true };

  const parsedUrl = new URL(req.url ?? "/", "http://localhost");
  const presentedInstanceToken = parsedUrl.searchParams.get(INSTANCE_TOKEN_QUERY_PARAM);
  const presentedWorktree = parsedUrl.searchParams.get(WORKTREE_QUERY_PARAM);
  const presentedAuthToken = extractToken(req);

  if (matchesInstanceAttachment(presentedAuthToken, presentedInstanceToken, presentedWorktree, expected)) return { ok: true };

  return {
    ok: false,
    code: "WRONG_INSTANCE",
    expectedWorktree: expected.worktreeIdentity ?? null,
    presentedWorktree,
  };
}

/** Checks every token and worktree value that identifies a single dev instance. */
function matchesInstanceAttachment(
  presentedAuthToken: string | null | undefined,
  presentedInstanceToken: string | null,
  presentedWorktree: string | null,
  expected: InstanceAttachmentExpectation,
): boolean {
  return matchesAuthToken(presentedAuthToken, expected.authToken)
    && matchesInstanceToken(presentedInstanceToken, expected.instanceToken)
    && matchesWorktreeIdentity(presentedWorktree, expected.worktreeIdentity);
}

/** Checks the regular authenticated connection token. */
function matchesAuthToken(presented: string | null | undefined, expected: string): boolean {
  return typeof presented === "string" && safeTokenEqual(presented, expected);
}

/** Checks the per-instance attachment token. */
function matchesInstanceToken(presented: string | null, expected: string | null | undefined): boolean {
  return typeof presented === "string" && typeof expected === "string" && safeTokenEqual(presented, expected);
}

/** Checks the worktree identity that belongs to the instance token. */
function matchesWorktreeIdentity(presented: string | null, expected: string | null | undefined): boolean {
  return typeof presented === "string" && typeof expected === "string" && presented === expected;
}

/** Create and configure the HTTP + WebSocket server. */
export function createWsServer(deps: WsServerDeps): {
  httpServer: NodeHTTP.Server;
  wss: WebSocketServer;
} {
  let wss: WebSocketServer;
  const httpServer = NodeHTTP.createServer((req: NodeHTTP.IncomingMessage, res: NodeHTTP.ServerResponse) => {
    const requestPath = new URL(req.url ?? "/", "http://localhost").pathname;
    if (handleSpecialHttpRequest(req, res, requestPath, deps, wss)) return;
    if (handleHealthRequest(req, res, deps)) return;
    if (handleShutdownRequest(req, res, deps)) return;
    if (handleAttachmentRequest(req, res, deps)) return;

    res.writeHead(404);
    res.end("Not found");
  });

  wss = new WebSocketServer({
    server: httpServer,
    maxPayload: 45 * 1024 * 1024,
    perMessageDeflate: {
      zlibDeflateOptions: { level: 6 },
      // Only compress messages larger than 1 KB to avoid CPU overhead on
      // small streaming delta events during active agent turns
      threshold: 1024,
      // Context takeover disabled server-side so the threshold check is
      // actually applied by the ws library (threshold is a no-op when
      // context takeover is enabled).
      clientNoContextTakeover: false,
      serverNoContextTakeover: true,
    },
  });

  // The ws library forwards httpServer 'error' events to wss via
  // `error: this.emit.bind(this, 'error')`. Without this listener, an
  // EADDRINUSE on httpServer would crash the process before listen()'s
  // EADDRINUSE retry handler in index.ts has a chance to run.
  wss.on("error", (err) => {
    logger.error("WebSocketServer error", {
      error: (err as NodeJS.ErrnoException).message,
      code: (err as NodeJS.ErrnoException).code,
      stack: (err as Error).stack,
    });
  });

  wss.on("connection", (ws: WebSocket, req: NodeHTTP.IncomingMessage) => {
    const instanceCheck = validateInstanceAttachment(req, deps);
    if (!instanceCheck.ok) {
      logger.warn("WebSocket connection rejected: wrong dev instance", {
        code: instanceCheck.code,
        expectedWorktree: instanceCheck.expectedWorktree,
        presentedWorktree: instanceCheck.presentedWorktree,
      });
      ws.send(JSON.stringify({
        type: "refusal",
        error: {
          code: instanceCheck.code,
          expectedWorktree: instanceCheck.expectedWorktree,
          presentedWorktree: instanceCheck.presentedWorktree,
        },
      }));
      ws.close(4001, instanceCheck.code);
      return;
    }

    const token = extractToken(req);
    if (!token || !safeTokenEqual(token, deps.authToken)) {
      logger.warn("WebSocket connection rejected: invalid token");
      ws.close(4001, "Unauthorized");
      return;
    }

    logger.info("WebSocket client connected");
    addClient(ws);
    let browserAutomationDesktopInstanceId: string | null = null;

    const resolveCurrentBrowserAutomationAuthorization = (): ReturnType<WsServerDeps["resolveBrowserAutomationHostAuthorization"]> => {
      try {
        const current = deps.resolveBrowserAutomationHostAuthorization(req);
        if (!current) return null;
        browserAutomationDesktopInstanceId ??= current.desktopInstanceId;
        return refreshBrowserAutomationHostAuthorization(current, browserAutomationDesktopInstanceId);
      } catch (error) {
        logger.warn("Browser automation host authorization could not be derived", {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    };

    const messageContext: WsMessageContext = {
      ws,
      deps,
      resolveCurrentBrowserAutomationAuthorization,
      pendingBinaryHeader: null,
    };

    ws.on("message", (data: Buffer | string, isBinary: boolean) => handleWsMessage(data, isBinary, messageContext));

    ws.on("close", () => {
      logger.info("WebSocket client disconnected");
      deps.browserAutomationBroker?.disconnect(ws);
      deps.terminalService.disconnectClient(ws);
      deps.workspaceInvalidations.unwatchClient(ws);
      removeClient(ws);
    });

    ws.on("error", (err) => {
      logger.error("WebSocket error", { error: err.message });
      deps.browserAutomationBroker?.disconnect(ws);
      deps.terminalService.disconnectClient(ws);
      deps.workspaceInvalidations.unwatchClient(ws);
      removeClient(ws);
    });
  });

  return { httpServer, wss };
}

/** Routes authenticated HTTP endpoints that require an asynchronous handler. */
function handleSpecialHttpRequest(
  req: NodeHTTP.IncomingMessage,
  res: NodeHTTP.ServerResponse,
  requestPath: string,
  deps: WsServerDeps,
  wss: WebSocketServer,
): boolean {
  if (requestPath === "/__mcode/reliability" && deps.reliabilityHarness?.enabled) {
    handleReliabilityRequest(req, res, deps.reliabilityHarness, wss);
    return true;
  }
  if (requestPath === "/mcp" && deps.browserAutomationMcpHandler) {
    handleBrowserAutomationMcpRequest(req, res, deps.browserAutomationMcpHandler);
    return true;
  }
  if (requestPath === EXTERNAL_THREAD_CONTROL_MCP_PATH && deps.externalThreadControlMcpRuntime) {
    handleThreadControlMcpRequest(req, res, deps.externalThreadControlMcpRuntime);
    return true;
  }
  return false;
}

/** Starts a reliability control request and returns its existing failure response. */
function handleReliabilityRequest(
  req: NodeHTTP.IncomingMessage,
  res: NodeHTTP.ServerResponse,
  reliabilityHarness: NonNullable<WsServerDeps["reliabilityHarness"]>,
  wss: WebSocketServer,
): void {
  void reliabilityHarness.handleRequest(req, res, wss.clients).catch((error: unknown) => {
    logger.error("Reliability harness request failed", { error: describeError(error) });
    if (!res.headersSent) res.writeHead(500);
    res.end("Reliability harness failure");
  });
}

/** Starts a browser MCP request and returns its JSON-RPC failure response when required. */
function handleBrowserAutomationMcpRequest(
  req: NodeHTTP.IncomingMessage,
  res: NodeHTTP.ServerResponse,
  handler: BrowserAutomationMcpHandler,
): void {
  void handler.handle(req, res).catch((error: unknown) => {
    logger.error("Browser automation MCP request failed", { error: describeError(error) });
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } }));
  });
}

/** Starts an external thread-control MCP request and returns its failure response when required. */
function handleThreadControlMcpRequest(
  req: NodeHTTP.IncomingMessage,
  res: NodeHTTP.ServerResponse,
  runtime: NonNullable<WsServerDeps["externalThreadControlMcpRuntime"]>,
): void {
  void runtime.handleRequest(req, res).catch((error: unknown) => {
    logger.error("External thread-control MCP request failed", { error: describeError(error) });
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
}

/** Serves the server health endpoint. */
function handleHealthRequest(req: NodeHTTP.IncomingMessage, res: NodeHTTP.ServerResponse, deps: WsServerDeps): boolean {
  if (req.method !== "GET" || !req.url?.startsWith("/health")) return false;
  const body = createHealthBody(deps);
  const headers = createHealthHeaders(deps);
  res.writeHead(200, headers);
  res.end(JSON.stringify(body));
  return true;
}

/** Creates the health response body for the current server state. */
function createHealthBody(deps: WsServerDeps): Record<string, unknown> {
  const body: Record<string, unknown> = {
    status: "ok",
    activeAgents: deps.agentService.runtimeAccess().activeCount(),
  };
  if (deps.browserAutomationBroker) {
    body.browserAutomation = {
      ...deps.browserAutomationBroker.status(),
      reliability: deps.browserAutomationBroker.reliabilityStatus(),
      nightlyEvidence: deps.browserAutomationBroker.nightlyEvidenceStatus(),
    };
  }
  if (!deps.singleInstance) body.authToken = deps.authToken;
  return body;
}

/** Creates the health response headers for the current server mode. */
function createHealthHeaders(deps: WsServerDeps): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (!deps.singleInstance) headers["Set-Cookie"] = buildAuthCookie(deps.authToken);
  return headers;
}

/** Serves the authenticated shutdown endpoint. */
function handleShutdownRequest(req: NodeHTTP.IncomingMessage, res: NodeHTTP.ServerResponse, deps: WsServerDeps): boolean {
  if (req.method !== "POST" || req.url !== "/shutdown") return false;
  if (!matchesAuthToken(extractToken(req), deps.authToken)) {
    res.writeHead(401);
    res.end("Unauthorized");
    return true;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "shutting_down" }), () => deps.shutdown());
  return true;
}

/** Serves an authenticated attachment request after path validation. */
function handleAttachmentRequest(req: NodeHTTP.IncomingMessage, res: NodeHTTP.ServerResponse, deps: WsServerDeps): boolean {
  if (req.method !== "GET" || !req.url?.startsWith("/attachments/")) return false;
  if (!matchesAuthToken(extractToken(req), deps.authToken)) {
    res.writeHead(401);
    res.end("Unauthorized");
    return true;
  }
  const attachment = parseAttachmentRequest(req, res);
  if (!attachment) return true;
  serveAttachment(attachment.threadId, attachment.filename, res);
  return true;
}

/** Parses and validates attachment path segments. */
function parseAttachmentRequest(req: NodeHTTP.IncomingMessage, res: NodeHTTP.ServerResponse): { threadId: string; filename: string } | null {
  const segments = new URL(req.url ?? "/", "http://localhost").pathname.split("/").filter(Boolean);
  if (segments.length !== 3 || segments[0] !== "attachments") {
    res.writeHead(404);
    res.end("Not found");
    return null;
  }
  const [_, threadId, filename] = segments;
  if (!ATTACHMENT_THREAD_SEGMENT.test(threadId!) || !ATTACHMENT_FILE_SEGMENT.test(filename!)) {
    res.writeHead(400);
    res.end("Invalid path");
    return null;
  }
  return { threadId: threadId!, filename: filename! };
}

/** Streams one validated attachment file to the HTTP response. */
function serveAttachment(threadId: string, filename: string, res: NodeHTTP.ServerResponse): void {
  const filePath = NodePath.join(getMcodeDir(), "attachments", threadId, filename);
  if (!NodeFS.existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const ext = filename.split(".").pop() ?? "";
  const stream = NodeFS.createReadStream(filePath);
  stream.on("error", () => handleAttachmentStreamError(res));
  res.writeHead(200, {
    "Content-Type": ATTACHMENT_EXT_MIME[ext] ?? "application/octet-stream",
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Security-Policy": "default-src 'none'",
  });
  stream.pipe(res);
}

/** Sends the attachment read failure response unless streaming already began. */
function handleAttachmentStreamError(res: NodeHTTP.ServerResponse): void {
  if (!res.headersSent) res.writeHead(404);
  res.end();
}

/** Formats unknown thrown values for log metadata. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Routes one WebSocket frame to terminal upload handling or JSON-RPC. */
function handleWsMessage(data: Buffer | string, isBinary: boolean, context: WsMessageContext): void {
  if (isBinary) {
    handleBinaryWsMessage(Buffer.isBuffer(data) ? data : Buffer.from(data), context);
    return;
  }
  handleTextWsMessage(typeof data === "string" ? data : data.toString("utf-8"), context);
}

/** Routes a binary terminal frame or a binary file-upload frame. */
function handleBinaryWsMessage(bytes: Buffer, context: WsMessageContext): void {
  if (isTerminalBinaryFrame(bytes)) {
    handleTerminalBinaryFrame(bytes, context);
    return;
  }
  const header = context.pendingBinaryHeader;
  context.pendingBinaryHeader = null;
  if (!header) {
    logger.warn("Received binary frame with no pending upload header");
    return;
  }
  handleFileUploadFrame(header, bytes, context.ws);
}

/** Checks whether a binary frame uses the terminal v1 magic prefix. */
function isTerminalBinaryFrame(bytes: Buffer): boolean {
  return bytes[0] === TERMINAL_BINARY_MAGIC[0] && bytes[1] === TERMINAL_BINARY_MAGIC[1];
}

/** Sends a terminal v1 frame to the terminal service. */
function handleTerminalBinaryFrame(bytes: Buffer, context: WsMessageContext): void {
  void context.deps.terminalService.handleV1Frame(context.ws, bytes).catch((error: unknown) => {
    logger.warn("Terminal v1 frame rejected", { error: describeError(error) });
    closeForTerminalRetry(error, context.ws);
  });
}

/** Closes a connection when a terminal error requires a non-safe retry. */
function closeForTerminalRetry(error: unknown, ws: WebSocket): void {
  if (!(error instanceof TerminalBackendError) || error.retry === "SAFE_RETRY" || ws.readyState !== WebSocket.OPEN) return;
  ws.close(4002, `Terminal ${error.retry.toLowerCase()} required`);
}

/** Handles a clipboard file-upload frame after its text header. */
function handleFileUploadFrame(header: BinaryUploadHeader, bytes: Buffer, ws: WebSocket): void {
  if (header.method !== "clipboard.saveFile") {
    logger.warn("Unsupported binary upload method", { method: header.method });
    sendWsJson(ws, {
      id: header.id,
      error: { code: "UNSUPPORTED_METHOD", message: `Binary upload not supported for method: ${header.method}` },
    });
    return;
  }
  const metadata = readUploadMetadata(header);
  if (!metadata) {
    logger.warn("Binary upload header missing required meta fields");
    sendWsJson(ws, {
      id: header.id,
      error: { code: "INVALID_UPLOAD", message: "meta.mimeType and meta.fileName are required strings" },
    });
    return;
  }
  void handleBinaryUpload(metadata, bytes)
    .then((result) => sendWsJson(ws, { id: header.id, result }))
    .catch((error: unknown) => handleFileUploadFailure(header.id, error, ws));
}

/** Reads the required file-upload metadata from an upload header. */
function readUploadMetadata(header: BinaryUploadHeader): { mimeType: string; fileName: string } | null {
  const { mimeType, fileName } = header.meta;
  if (typeof mimeType !== "string" || !mimeType || typeof fileName !== "string" || !fileName) return null;
  return { mimeType, fileName };
}

/** Reports a binary upload failure to the initiating WebSocket client. */
function handleFileUploadFailure(id: string | number | null, error: unknown, ws: WebSocket): void {
  const message = describeError(error);
  logger.error("Binary upload failed", { error: message });
  sendWsJson(ws, { id, error: { code: "UPLOAD_FAILED", message } });
}

/** Sends JSON only while the WebSocket remains open. */
function sendWsJson(ws: WebSocket, value: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
}

/** Routes a text upload header or a regular JSON-RPC message. */
function handleTextWsMessage(raw: string, context: WsMessageContext): void {
  const header = parseBinaryUploadHeader(raw);
  if (header) {
    replacePendingUploadHeader(header, context);
    return;
  }
  routeWsMessage(raw, context);
}

/** Parses a text frame as a binary-upload header. */
function parseBinaryUploadHeader(raw: string): BinaryUploadHeader | null {
  try {
    const headerResult = BinaryUploadHeaderSchema().safeParse(JSON.parse(raw));
    return headerResult.success ? headerResult.data : null;
  } catch {
    return null;
  }
}

/** Replaces a pending upload header and reports the abandoned upload. */
function replacePendingUploadHeader(header: BinaryUploadHeader, context: WsMessageContext): void {
  const previous = context.pendingBinaryHeader;
  if (previous) {
    logger.warn("Binary upload header overwritten; previous upload abandoned", { staleId: previous.id });
    sendWsJson(context.ws, {
      id: previous.id,
      error: { code: "UPLOAD_ABANDONED", message: "Upload header was overwritten by a subsequent upload" },
    });
  }
  context.pendingBinaryHeader = header;
}

/** Routes a regular JSON-RPC frame and returns its response to the same client. */
function routeWsMessage(raw: string, context: WsMessageContext): void {
  void routeMessage(raw, context.deps, {
    client: context.ws,
    browserAutomationAuthorization: context.resolveCurrentBrowserAutomationAuthorization(),
  })
    .then((response) => sendWsJson(context.ws, response))
    .catch((error: unknown) => logger.error("Unexpected router error", { error: describeError(error) }));
}
