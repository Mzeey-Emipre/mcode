import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { inject, injectable } from "tsyringe";
import { ExternalThreadControlPairingService } from "./external-thread-control-pairing-service.js";
import { createExternalThreadControlMcpSession, type ExternalThreadControlMcpSession } from "./external-thread-control-mcp-transport.js";
import { ThreadControlService } from "./thread-control-service.js";

/** Existing-server loopback path used by paired external MCP clients. */
export const EXTERNAL_THREAD_CONTROL_MCP_PATH = "/mcp/external-thread-control";

/** Loopback MCP runtime mounted into the existing HTTP server. */
@injectable()
export class ExternalThreadControlMcpRuntime {
  private readonly session: ExternalThreadControlMcpSession;
  private readonly server: McpServer;
  private transport: StreamableHTTPServerTransport | undefined;
  private connecting: Promise<void> | undefined;
  private listenPort = Number.parseInt(process.env.MCODE_PORT ?? "19400", 10);

  constructor(
    @inject(ThreadControlService) service: ThreadControlService,
    @inject(ExternalThreadControlPairingService) private readonly pairings: ExternalThreadControlPairingService,
  ) {
    this.session = createExternalThreadControlMcpSession({ pairingService: pairings, service });
    this.server = this.session.createServer();
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
    if (request.method !== "POST") {
      response.writeHead(404).end();
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
    await this.ensureConnected();
    await this.session.contextStorage.run(context, () => this.transport!.handleRequest(request, response));
  }

  /** Reconcile uncertain external work before accepting new deliveries after restart. */
  reconcileOnStartup(): number {
    return this.pairings.reconcileInFlight();
  }

  /** Close MCP transport during server shutdown. */
  async close(): Promise<void> {
    await this.transport?.close().catch(() => undefined);
    await this.server.close().catch(() => undefined);
    this.transport = undefined;
  }

  private async ensureConnected(): Promise<void> {
    if (this.transport) return;
    if (this.connecting) return this.connecting;
    const connecting = (async () => {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await this.server.connect(transport);
      this.transport = transport;
    })();
    this.connecting = connecting;
    try {
      await connecting;
    } finally {
      if (this.connecting === connecting) this.connecting = undefined;
    }
  }
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
