/**
 * HTTP + WebSocket server setup.
 * Creates an HTTP server for health checks and attachment serving,
 * and a WebSocket server on the same port for RPC + push events.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { logger } from "@mcode/shared";
import { TerminalBackendError } from "../../features/terminal/backends/terminal-backend.js";
import { BinaryUploadHeaderSchema, TERMINAL_BINARY_MAGIC, type BinaryUploadHeader } from "@mcode/contracts";
import { routeMessage, type RouterDeps } from "./ws-router.js";
import { addClient, removeClient } from "./push.js";
import { handleBinaryUpload } from "../../features/attachments/transport/binary-upload.js";
import { timingSafeEqual } from "crypto";
import { extractToken, buildAuthCookie } from "./auth.js";
import { createReadStream, existsSync } from "fs";
import { join } from "path";
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
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
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

/** Query parameters used by browser clients to prove they target this dev instance. */
export const INSTANCE_TOKEN_QUERY_PARAM = "instanceToken";
export const WORKTREE_QUERY_PARAM = "worktree";

/** Validates the single-instance token and worktree identity from a WebSocket request. */
export function validateInstanceAttachment(
  req: IncomingMessage,
  expected: { singleInstance?: boolean; authToken: string; instanceToken?: string | null; worktreeIdentity?: string | null },
): InstanceCheckResult {
  if (!expected.singleInstance) return { ok: true };

  const parsedUrl = new URL(req.url ?? "/", "http://localhost");
  const presentedInstanceToken = parsedUrl.searchParams.get(INSTANCE_TOKEN_QUERY_PARAM);
  const presentedWorktree = parsedUrl.searchParams.get(WORKTREE_QUERY_PARAM);
  const presentedAuthToken = extractToken(req);

  const matchesAuth =
    typeof presentedAuthToken === "string" && safeTokenEqual(presentedAuthToken, expected.authToken);
  const matchesInstance =
    typeof expected.instanceToken === "string" &&
    typeof presentedInstanceToken === "string" &&
    safeTokenEqual(presentedInstanceToken, expected.instanceToken);
  const matchesWorktree =
    typeof expected.worktreeIdentity === "string" &&
    typeof presentedWorktree === "string" &&
    presentedWorktree === expected.worktreeIdentity;

  if (matchesAuth && matchesInstance && matchesWorktree) {
    return { ok: true };
  }

  return {
    ok: false,
    code: "WRONG_INSTANCE",
    expectedWorktree: expected.worktreeIdentity ?? null,
    presentedWorktree,
  };
}

/** Create and configure the HTTP + WebSocket server. */
export function createWsServer(deps: WsServerDeps): {
  httpServer: Server;
  wss: WebSocketServer;
} {
  let wss: WebSocketServer;
  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const requestPath = new URL(req.url ?? "/", "http://localhost").pathname;
    if (deps.reliabilityHarness?.enabled && requestPath === "/__mcode/reliability") {
      void deps.reliabilityHarness.handleRequest(req, res, wss.clients).catch((error: unknown) => {
        logger.error("Reliability harness request failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        if (!res.headersSent) res.writeHead(500);
        res.end("Reliability harness failure");
      });
      return;
    }
    if (requestPath === "/mcp" && deps.browserAutomationMcpHandler) {
      void deps.browserAutomationMcpHandler.handle(req, res).catch((error: unknown) => {
        logger.error("Browser automation MCP request failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } }));
      });
      return;
    }
    if (requestPath === EXTERNAL_THREAD_CONTROL_MCP_PATH && deps.externalThreadControlMcpRuntime) {
      void deps.externalThreadControlMcpRuntime.handleRequest(req, res).catch((error: unknown) => {
        logger.error("External thread-control MCP request failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
      return;
    }
    const token = extractToken(req);

    if (req.method === "GET" && req.url?.startsWith("/health")) {
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
      if (!deps.singleInstance) {
        // Shared-server mode keeps the legacy localhost token recovery path.
        body.authToken = deps.authToken;
      }
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (!deps.singleInstance) {
        headers["Set-Cookie"] = buildAuthCookie(deps.authToken);
      }
      res.writeHead(200, headers);
      res.end(JSON.stringify(body));
      return;
    }

    if (req.method === "POST" && req.url === "/shutdown") {
      if (!token || !safeTokenEqual(token, deps.authToken)) {
        res.writeHead(401);
        res.end("Unauthorized");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "shutting_down" }), () => deps.shutdown());
      return;
    }

    if (req.method === "GET" && req.url?.startsWith("/attachments/")) {
      const attachmentToken = extractToken(req);
      if (!attachmentToken || !safeTokenEqual(attachmentToken, deps.authToken)) {
        res.writeHead(401);
        res.end("Unauthorized");
        return;
      }

      const parsedUrl = new URL(req.url, "http://localhost");
      const segments = parsedUrl.pathname.split("/").filter(Boolean);
      if (segments.length !== 3 || segments[0] !== "attachments") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const threadId = segments[1]!;
      const filename = segments[2]!;
      if (!ATTACHMENT_THREAD_SEGMENT.test(threadId) || !ATTACHMENT_FILE_SEGMENT.test(filename)) {
        res.writeHead(400);
        res.end("Invalid path");
        return;
      }

      const filePath = join(getMcodeDir(), "attachments", threadId, filename);
      if (!existsSync(filePath)) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const ext = filename.split(".").pop() ?? "";
      const stream = createReadStream(filePath);
      stream.on("error", () => {
        if (!res.headersSent) {
          res.writeHead(404);
        }
        res.end();
      });
      res.writeHead(200, {
        "Content-Type": ATTACHMENT_EXT_MIME[ext] ?? "application/octet-stream",
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Security-Policy": "default-src 'none'",
      });
      stream.pipe(res);
      return;
    }

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

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
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

    /** Pending binary upload header for this connection. */
    let pendingBinaryHeader: BinaryUploadHeader | null = null;

    ws.on("message", (data: Buffer | string, isBinary: boolean) => {
      // Binary frame: match to pending header
      if (isBinary) {
        const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (bytes[0] === TERMINAL_BINARY_MAGIC[0] && bytes[1] === TERMINAL_BINARY_MAGIC[1]) {
          void deps.terminalService.handleV1Frame(ws, bytes).catch((error: unknown) => {
            logger.warn("Terminal v1 frame rejected", {
              error: error instanceof Error ? error.message : String(error),
            });
            // v1 has no error binary frame. A typed retry class is therefore
            // recovered through the existing authenticated WebSocket reconnect,
            // which re-lists and reattaches sessions in the renderer.
            if (error instanceof TerminalBackendError && error.retry !== "SAFE_RETRY" && ws.readyState === WebSocket.OPEN) {
              ws.close(4002, `Terminal ${error.retry.toLowerCase()} required`);
            }
          });
          return;
        }
        const header = pendingBinaryHeader;
        pendingBinaryHeader = null;

        if (!header) {
          logger.warn("Received binary frame with no pending upload header");
          return;
        }

        if (header.method !== "clipboard.saveFile") {
          logger.warn("Unsupported binary upload method", { method: header.method });
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              id: header.id,
              error: { code: "UNSUPPORTED_METHOD", message: `Binary upload not supported for method: ${header.method}` },
            }));
          }
          return;
        }

        const mimeType = header.meta.mimeType;
        const fileName = header.meta.fileName;
        if (typeof mimeType !== "string" || !mimeType || typeof fileName !== "string" || !fileName) {
          logger.warn("Binary upload header missing required meta fields");
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              id: header.id,
              error: { code: "INVALID_UPLOAD", message: "meta.mimeType and meta.fileName are required strings" },
            }));
          }
          return;
        }

        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);

        handleBinaryUpload({ mimeType, fileName }, buffer)
          .then((result) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ id: header.id, result }));
            }
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            logger.error("Binary upload failed", { error: message });
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ id: header.id, error: { code: "UPLOAD_FAILED", message } }));
            }
          });
        return;
      }

      // Text frame: check if it's a binary upload header or normal RPC
      const raw = typeof data === "string" ? data : data.toString("utf-8");

      try {
        const parsed = JSON.parse(raw);
        const headerResult = BinaryUploadHeaderSchema.safeParse(parsed);
        if (headerResult.success) {
          // If a previous header was pending without a binary frame, reject it
          if (pendingBinaryHeader) {
            const staleId = pendingBinaryHeader.id;
            logger.warn("Binary upload header overwritten; previous upload abandoned", { staleId });
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                id: staleId,
                error: { code: "UPLOAD_ABANDONED", message: "Upload header was overwritten by a subsequent upload" },
              }));
            }
          }
          pendingBinaryHeader = headerResult.data;
          return; // Wait for the next binary frame
        }
      } catch {
        // Not JSON or not a header — fall through to normal routing
      }

      routeMessage(raw, deps, {
        client: ws,
        browserAutomationAuthorization: resolveCurrentBrowserAutomationAuthorization(),
      })
        .then((response) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(response));
          }
        })
        .catch((err: unknown) => {
          logger.error("Unexpected router error", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    });

    ws.on("close", () => {
      logger.info("WebSocket client disconnected");
      deps.browserAutomationBroker?.disconnect(ws);
      deps.terminalService.disconnectClient(ws);
      removeClient(ws);
    });

    ws.on("error", (err) => {
      logger.error("WebSocket error", { error: err.message });
      deps.browserAutomationBroker?.disconnect(ws);
      deps.terminalService.disconnectClient(ws);
      removeClient(ws);
    });
  });

  return { httpServer, wss };
}
