import { createServer, type Server } from "node:http";
import { inject, injectable } from "tsyringe";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  constantTimeCredentialEqual,
  InternalThreadControlMcpAuthority,
  type ActivateInternalThreadControlMcpLease,
} from "./thread-control-mcp-authority.js";
import { createInternalThreadControlMcpSession } from "./thread-control-mcp-transport.js";
import { ThreadControlService } from "./thread-control-service.js";

const CODEX_MCP_TOKEN_ENV = "MCODE_INTERNAL_THREAD_CONTROL_TOKEN";
const CODEX_MCP_NAME = "mcode_internal_thread_control";

/** Server-only lifecycle bridge for provider-injected thread-control MCP sessions. */
@injectable()
export class InternalThreadControlMcpRuntime {
  private readonly transport;
  private readonly httpSessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();
  private httpServer: Server | undefined;
  private httpPort: number | undefined;
  private httpServerStartup: Promise<void> | undefined;

  constructor(
    @inject(ThreadControlService) service: ThreadControlService,
    @inject(InternalThreadControlMcpAuthority) private readonly authority: InternalThreadControlMcpAuthority,
  ) {
    this.transport = createInternalThreadControlMcpSession({ authority, service });
  }

  /** Activates the current intentional turn while preserving the pooled-session credential. */
  activate(input: ActivateInternalThreadControlMcpLease): void {
    this.authority.activate(input);
  }

  /** Revokes the active turn lease without destroying a reusable provider session. */
  revoke(sessionId: string): void {
    this.authority.revoke(sessionId);
  }

  /** Closes all MCP state owned by a provider session. */
  async close(sessionId: string): Promise<void> {
    this.authority.close(sessionId);
    const entry = this.httpSessions.get(sessionId);
    this.httpSessions.delete(sessionId);
    if (entry) {
      await entry.transport.close().catch(() => undefined);
    }
    const server = this.httpSessions.size === 0 ? this.httpServer : undefined;
    if (server) {
      this.httpServer = undefined;
      this.httpPort = undefined;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }

  /** Creates the Claude SDK in-process MCP server for an active provider session. */
  createClaudeServer(sessionId: string): McpServer | undefined {
    const credential = this.authority.credential(sessionId);
    return credential ? this.transport.createServer(credential) : undefined;
  }

  /** Creates bounded loopback configuration for one Codex app-server session. */
  async createCodexConfiguration(sessionId: string): Promise<{ configOverrides: string[]; env: Record<string, string> } | undefined> {
    const credential = this.authority.credential(sessionId);
    if (!credential) return undefined;
    await this.ensureHttpServer();
    if (!this.httpPort) return undefined;
    if (!this.httpSessions.has(sessionId)) {
      const server = this.transport.createServer(credential);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      this.httpSessions.set(sessionId, { server, transport });
    }
    const url = `http://127.0.0.1:${this.httpPort}/${encodeURIComponent(sessionId)}`;
    return {
      configOverrides: [
        `mcp_servers.${CODEX_MCP_NAME}.url=\"${url}\"`,
        `mcp_servers.${CODEX_MCP_NAME}.bearer_token_env_var=\"${CODEX_MCP_TOKEN_ENV}\"`,
      ],
      env: { [CODEX_MCP_TOKEN_ENV]: credential },
    };
  }

  private async ensureHttpServer(): Promise<void> {
    if (this.httpServer) return;
    if (this.httpServerStartup) return this.httpServerStartup;
    const startup = this.startHttpServer();
    this.httpServerStartup = startup;
    try {
      await startup;
    } finally {
      if (this.httpServerStartup === startup) this.httpServerStartup = undefined;
    }
  }

  private async startHttpServer(): Promise<void> {
    const server = createServer((request, response) => {
      const encodedSessionId = request.url?.slice(1);
      if (!encodedSessionId || request.method !== "POST") {
        response.writeHead(404).end();
        return;
      }
      let sessionId: string;
      try {
        sessionId = decodeURIComponent(encodedSessionId);
      } catch {
        response.writeHead(401).end();
        return;
      }
      const entry = this.httpSessions.get(sessionId);
      const credential = entry && this.authority.credential(sessionId);
      if (!entry || !credential || !constantTimeCredentialEqual(request.headers.authorization ?? "", `Bearer ${credential}`)) {
        response.writeHead(401).end();
        return;
      }
      void entry.transport.handleRequest(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Internal MCP loopback listener did not expose a TCP port");
    }
    this.httpServer = server;
    this.httpPort = address.port;
  }
}
