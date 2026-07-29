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

/** Authenticated HTTP MCP connection details for one pooled provider session. */
export interface InternalThreadControlMcpHttpConnection {
  name: string;
  url: string;
  headers: Record<string, string>;
}

/** Server-only lifecycle bridge for provider-injected thread-control MCP sessions. */
@injectable()
export class InternalThreadControlMcpRuntime {
  private readonly transport;
  private readonly httpSessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();
  private httpServer: Server | undefined;
  private httpPort: number | undefined;
  private httpServerStartup: Promise<void> | undefined;
  private lifecycleTail: Promise<void> = Promise.resolve();

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
    await this.inLifecycle(async () => {
      const entry = this.httpSessions.get(sessionId);
      this.httpSessions.delete(sessionId);
      if (entry) {
        await entry.transport.close().catch(() => undefined);
      }
      await this.closeHttpServerWhenIdle();
    });
  }

  /** Creates the Claude SDK in-process MCP server for an active provider session. */
  createClaudeServer(sessionId: string): McpServer | undefined {
    const credential = this.authority.credential(sessionId);
    return credential ? this.transport.createServer(credential) : undefined;
  }

  /** Creates one authenticated loopback HTTP connection for a pooled provider session. */
  async createHttpConnection(sessionId: string): Promise<InternalThreadControlMcpHttpConnection | undefined> {
    const credential = this.authority.credential(sessionId);
    if (!credential) return undefined;
    return this.inLifecycle(async () => {
      await this.ensureHttpServer();
      if (credential !== this.authority.credential(sessionId) || !this.httpPort) {
        await this.closeHttpServerWhenIdle();
        return undefined;
      }
      if (!this.httpSessions.has(sessionId)) {
        const server = this.transport.createServer(credential);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => sessionId });
        await server.connect(transport);
        if (credential !== this.authority.credential(sessionId)) {
          await transport.close().catch(() => undefined);
          await this.closeHttpServerWhenIdle();
          return undefined;
        }
        this.httpSessions.set(sessionId, { server, transport });
      }
      return {
        name: CODEX_MCP_NAME,
        url: `http://127.0.0.1:${this.httpPort}/${encodeURIComponent(sessionId)}`,
        headers: { Authorization: `Bearer ${credential}` },
      };
    });
  }

  /** Creates bounded loopback configuration for one Codex app-server session. */
  async createCodexConfiguration(sessionId: string): Promise<{ configOverrides: string[]; env: Record<string, string> } | undefined> {
    const connection = await this.createHttpConnection(sessionId);
    if (!connection) return undefined;
    const authorization = connection.headers.Authorization;
    const credential = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    if (!credential) return undefined;
    return {
      configOverrides: [
        `mcp_servers.${connection.name}.url=\"${connection.url}\"`,
        `mcp_servers.${connection.name}.bearer_token_env_var=\"${CODEX_MCP_TOKEN_ENV}\"`,
      ],
      env: { [CODEX_MCP_TOKEN_ENV]: credential },
    };
  }

  private async inLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.lifecycleTail;
    this.lifecycleTail = next;
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async closeHttpServerWhenIdle(): Promise<void> {
    if (this.httpSessions.size > 0 || !this.httpServer) return;
    const server = this.httpServer;
    this.httpServer = undefined;
    this.httpPort = undefined;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
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
      if (!encodedSessionId) {
        response.writeHead(404).end();
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(request.method === "GET" ? 405 : 404).end();
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
