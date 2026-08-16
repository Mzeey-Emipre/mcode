import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { inject, injectable } from "tsyringe";
import { ExternalThreadControlPairingService } from "./external-thread-control-pairing-service.js";
import { createExternalThreadControlMcpSession, type ExternalThreadControlMcpSession } from "./external-thread-control-mcp-transport.js";
import { ThreadControlService } from "../features/agents/collaboration/thread-control-service.js";

/** Existing-server loopback path used by paired external MCP clients. */
export const EXTERNAL_THREAD_CONTROL_MCP_PATH = "/mcp/external-thread-control";

const MAX_BODY_BYTES = 256 * 1_024;

/** Loopback MCP runtime mounted into the existing HTTP server. */
@injectable()
export class ExternalThreadControlMcpRuntime {
  private readonly session: ExternalThreadControlMcpSession;
  private readonly activeRequests = new Set<{
    server: McpServer;
    transport: StreamableHTTPServerTransport;
  }>();
  private listenPort = Number.parseInt(process.env.MCODE_PORT ?? "19400", 10);

  constructor(
    @inject(ThreadControlService) service: ThreadControlService,
    @inject(ExternalThreadControlPairingService) private readonly pairings: ExternalThreadControlPairingService,
  ) {
    this.session = createExternalThreadControlMcpSession({ pairingService: pairings, service });
  }

  /** Return loopback endpoint URL for pairing-management responses. */
  endpoint(): string {
    return `http://127.0.0.1:${this.listenPort}${EXTERNAL_THREAD_CONTROL_MCP_PATH}`;
  }

  /** Publish the actual port after the shared HTTP server binds. */
  setPort(port: number): void {
    if (Number.isInteger(port) && port > 0 && port <= 65_535) this.listenPort = port;
  }

  /** Handle one authenticated loopback request without opening a second listener. */
  async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!isLoopback(request.socket.remoteAddress)) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    if (contentLengthExceedsLimit(request)) {
      response.writeHead(413).end("Request body is too large");
      return;
    }
    const credential = bearerCredential(request.headers.authorization);
    if (!credential) {
      response.writeHead(401).end("Unauthorized");
      return;
    }
    const context = {
      bearerCredential: credential,
      pairingId: headerValue(request, "x-mcode-pairing-id"),
      authorityEpoch: parseEpoch(headerValue(request, "x-mcode-authority-epoch")),
      deliveryId: headerValue(request, "x-mcode-delivery-id"),
    };
    try {
      this.pairings.authenticate(context.bearerCredential, context.pairingId, context.authorityEpoch);
    } catch {
      response.writeHead(401).end("Unauthorized");
      return;
    }
    let body: Buffer;
    try {
      body = await readBoundedBody(request);
    } catch (error) {
      if (error instanceof RangeError) {
        response.writeHead(413).end("Request body is too large");
        return;
      }
      throw error;
    }
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(body.toString("utf8"));
    } catch {
      response.writeHead(400).end("Parse error");
      return;
    }
    const server = this.session.createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const activeRequest = { server, transport };
    this.activeRequests.add(activeRequest);
    try {
      await server.connect(transport);
      await this.session.contextStorage.run(context, () => transport.handleRequest(request, response, parsedBody));
    } finally {
      this.activeRequests.delete(activeRequest);
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  }

  /** Reconcile uncertain external work before accepting new deliveries after restart. */
  reconcileOnStartup(): number {
    return this.pairings.reconcileInFlight();
  }

  /** Close MCP transport during server shutdown. */
  async close(): Promise<void> {
    const activeRequests = [...this.activeRequests];
    await Promise.all(activeRequests.map(async ({ server, transport }) => {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }));
    this.activeRequests.clear();
  }
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function contentLengthExceedsLimit(request: IncomingMessage): boolean {
  const header = request.headers["content-length"];
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined || !/^\d+$/.test(value)) return false;
  const length = Number(value);
  return !Number.isSafeInteger(length) || length > MAX_BODY_BYTES;
}

async function readBoundedBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new RangeError("request-too-large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size);
}

function bearerCredential(value: string | undefined): string | undefined {
  if (!value?.startsWith("Bearer ")) return undefined;
  const credential = value.slice("Bearer ".length).trim();
  return credential.length > 0 ? credential : undefined;
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function parseEpoch(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const epoch = Number(value);
  return Number.isSafeInteger(epoch) && epoch > 0 ? epoch : undefined;
}
