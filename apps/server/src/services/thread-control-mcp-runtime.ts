import { createServer, type Server } from "node:http";
import { inject, injectable } from "tsyringe";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InternalThreadControlMcpAuthority, type ActivateInternalThreadControlMcpLease } from "./thread-control-mcp-authority.js";
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
  close(sessionId: string): void {
    this.authority.close(sessionId);
    const entry = this.httpSessions.get(sessionId);
    this.httpSessions.delete(sessionId);
    void entry?.transport.close();
    if (this.httpSessions.size === 0 && this.httpServer) {
      void new Promise<void>((resolve) => this.httpServer?.close(() => resolve()));
      this.httpServer = undefined;
      this.httpPort = undefined;
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
    const server = createServer((request, response) => {
      const sessionId = request.url?.slice(1);
      if (!sessionId || request.method !== "POST") {
        response.writeHead(404).end();
        return;
      }
      const entry = this.httpSessions.get(decodeURIComponent(sessionId));
      const credential = entry && this.authority.credential(decodeURIComponent(sessionId));
      if (!entry || !credential || request.headers.authorization !== `Bearer ${credential}`) {
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
