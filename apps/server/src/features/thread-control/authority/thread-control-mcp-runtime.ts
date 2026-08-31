import * as NodeCrypto from "node:crypto";
import * as NodeHTTP from "node:http";
import * as NodeStream from "node:stream";
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
const MAX_HTTP_CLIENT_SESSIONS = 4;
/** Maximum bytes accepted for one loopback MCP request body. */
export const MAX_INTERNAL_MCP_REQUEST_BODY_BYTES = 1_048_576;
/** Socket and request deadline for loopback MCP traffic. */
export const INTERNAL_MCP_REQUEST_TIMEOUT_MS = 15_000;

type HttpClientSession = { server: McpServer; transport: StreamableHTTPServerTransport };

type HttpProviderSession = {
  credential: string;
  clients: Map<string, HttpClientSession>;
  pending: Set<StreamableHTTPServerTransport>;
  closed: boolean;
};

type AuthorizedHttpRequest = {
  sessionId: string;
  entry: HttpProviderSession;
  clientSessionId: string | undefined;
};

type HttpRequestRoute = "initialize" | "dispatch" | "method-not-allowed" | "not-found";

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
  private readonly httpSessions = new Map<string, HttpProviderSession>();
  private httpServer: NodeHTTP.Server | undefined;
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
        entry.closed = true;
        await Promise.all([
          ...Array.from(entry.clients.values(), ({ transport }) => transport.close().catch(() => undefined)),
          ...Array.from(entry.pending, (transport) => transport.close().catch(() => undefined)),
        ]);
        entry.clients.clear();
        entry.pending.clear();
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
      const entry = this.httpSessions.get(sessionId);
      if (entry && entry.credential !== credential) {
        return undefined;
      }
      if (!entry) {
        this.httpSessions.set(sessionId, {
          credential,
          clients: new Map(),
          pending: new Set(),
          closed: false,
        });
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
        `mcp_servers.${connection.name}.url="${connection.url}"`,
        `mcp_servers.${connection.name}.bearer_token_env_var="${CODEX_MCP_TOKEN_ENV}"`,
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
    const server = NodeHTTP.createServer((request, response) => this.handleHttpRequest(request, response));
    server.requestTimeout = INTERNAL_MCP_REQUEST_TIMEOUT_MS;
    server.headersTimeout = INTERNAL_MCP_REQUEST_TIMEOUT_MS;
    server.timeout = INTERNAL_MCP_REQUEST_TIMEOUT_MS;
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

  private handleHttpRequest(request: NodeHTTP.IncomingMessage, response: NodeHTTP.ServerResponse): void {
    this.applyRequestTimeout(request, response);
    const authorized = this.authorizeHttpRequest(request, response);
    if (!authorized) return;
    this.routeHttpRequest(request, response, authorized);
  }

  private applyRequestTimeout(request: NodeHTTP.IncomingMessage, response: NodeHTTP.ServerResponse): void {
    request.setTimeout(INTERNAL_MCP_REQUEST_TIMEOUT_MS, () => {
      if (!response.headersSent) response.writeHead(408).end();
      request.destroy();
    });
  }

  private authorizeHttpRequest(
    request: NodeHTTP.IncomingMessage,
    response: NodeHTTP.ServerResponse,
  ): AuthorizedHttpRequest | undefined {
    const sessionId = readRequestSessionId(request, response);
    if (!sessionId) return undefined;
    const entry = this.httpSessions.get(sessionId);
    const credential = entry && this.authority.credential(sessionId);
    if (!entry || entry.closed || !credential || !constantTimeCredentialEqual(request.headers.authorization ?? "", `Bearer ${credential}`)) {
      response.writeHead(401).end();
      return undefined;
    }
    const clientSession = readClientSessionHeader(request);
    if (clientSession.invalid) {
      response.writeHead(404).end();
      return undefined;
    }
    return { sessionId, entry, clientSessionId: clientSession.value };
  }

  private routeHttpRequest(
    request: NodeHTTP.IncomingMessage,
    response: NodeHTTP.ServerResponse,
    authorized: AuthorizedHttpRequest,
  ): void {
    const route = resolveHttpRequestRoute(request.method, authorized.clientSessionId);
    if (route === "method-not-allowed") {
      response.writeHead(405).end();
      return;
    }
    if (route === "not-found") {
      response.writeHead(404).end();
      return;
    }
    if (route === "initialize") {
      void this.handleBoundedRequest(request, response, (boundedRequest) =>
        this.handleHttpInitialize(authorized.sessionId, authorized.entry, boundedRequest, response));
      return;
    }
    const client = authorized.entry.clients.get(authorized.clientSessionId!);
    if (!client) {
      response.writeHead(404).end();
      return;
    }
    void this.handleBoundedRequest(request, response, (boundedRequest) =>
      client.transport.handleRequest(boundedRequest, response));
  }

  private async handleHttpInitialize(
    sessionId: string,
    entry: HttpProviderSession,
    request: NodeHTTP.IncomingMessage,
    response: NodeHTTP.ServerResponse,
  ): Promise<void> {
    if (entry.clients.size + entry.pending.size >= MAX_HTTP_CLIENT_SESSIONS) {
      response.writeHead(429).end();
      return;
    }
    const server = this.transport.createServer(entry.credential);
    let transport!: StreamableHTTPServerTransport;
    let registered = false;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => NodeCrypto.randomUUID(),
      onsessioninitialized: (clientSessionId) => {
        entry.pending.delete(transport);
        if (entry.closed || this.httpSessions.get(sessionId) !== entry) {
          void transport.close().catch(() => undefined);
          return;
        }
        entry.clients.set(clientSessionId, { server, transport });
        registered = true;
      },
      onsessionclosed: (clientSessionId) => {
        if (entry.clients.get(clientSessionId)?.transport === transport) {
          entry.clients.delete(clientSessionId);
        }
      },
    });
    entry.pending.add(transport);
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response);
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    } finally {
      entry.pending.delete(transport);
      if (!registered) await transport.close().catch(() => undefined);
    }
  }

  private async handleBoundedRequest(
    request: NodeHTTP.IncomingMessage,
    response: NodeHTTP.ServerResponse,
    handler: (boundedRequest: NodeHTTP.IncomingMessage) => Promise<void>,
  ): Promise<void> {
    const declaredLength = parseContentLength(request);
    if (declaredLength === "invalid") {
      response.writeHead(400, { Connection: "close" }).end();
      request.pause();
      return;
    }
    if (declaredLength !== undefined && declaredLength > MAX_INTERNAL_MCP_REQUEST_BODY_BYTES) {
      response.writeHead(413, { Connection: "close" }).end();
      request.pause();
      return;
    }

    const chunks: Buffer[] = [];
    let received = 0;
    let rejected = false;
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        request.off("data", onData);
        request.off("end", onEnd);
        request.off("error", onError);
      };
      const onData = (chunk: Buffer): void => {
        received += chunk.length;
        if (received > MAX_INTERNAL_MCP_REQUEST_BODY_BYTES) {
          rejected = true;
          cleanup();
          request.pause();
          resolve();
          return;
        }
        chunks.push(Buffer.from(chunk));
      };
      const onEnd = (): void => {
        cleanup();
        resolve();
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      request.on("data", onData);
      request.once("end", onEnd);
      request.once("error", onError);
    });
    if (rejected) {
      response.writeHead(413, { Connection: "close" }).end();
      return;
    }
    const body = new NodeStream.PassThrough();
    const boundedRequest = Object.assign(body, {
      method: request.method,
      headers: request.headers,
      url: request.url,
      httpVersion: request.httpVersion,
      httpVersionMajor: request.httpVersionMajor,
      httpVersionMinor: request.httpVersionMinor,
      socket: request.socket,
      rawHeaders: request.rawHeaders,
      rawTrailers: request.rawTrailers,
    }) as unknown as NodeHTTP.IncomingMessage;
    body.end(Buffer.concat(chunks));
    try {
      await handler(boundedRequest);
    } catch {
      if (!response.headersSent && !rejected) response.writeHead(500).end();
    } finally {
      body.destroy();
    }
  }
}

function readClientSessionHeader(request: NodeHTTP.IncomingMessage): { value?: string; invalid: boolean } {
  const header = request.headers["mcp-session-id"];
  if (header === undefined) return { invalid: false };
  if (typeof header !== "string" || header.length === 0 || header.length > 256) return { invalid: true };
  return { value: header, invalid: false };
}

function readRequestSessionId(request: NodeHTTP.IncomingMessage, response: NodeHTTP.ServerResponse): string | undefined {
  const encodedSessionId = request.url?.split("?", 1)[0]?.slice(1);
  if (!encodedSessionId) {
    response.writeHead(404).end();
    return undefined;
  }
  try {
    return decodeURIComponent(encodedSessionId);
  } catch {
    response.writeHead(401).end();
    return undefined;
  }
}

function resolveHttpRequestRoute(
  method: string | undefined,
  clientSessionId: string | undefined,
): HttpRequestRoute {
  if (method === "GET" && !clientSessionId) return "method-not-allowed";
  if (method === "POST" && !clientSessionId) return "initialize";
  if (method !== "POST" && method !== "GET" && method !== "DELETE") return "not-found";
  return clientSessionId ? "dispatch" : "not-found";
}

function parseContentLength(request: NodeHTTP.IncomingMessage): number | "invalid" | undefined {
  const raw = request.headers["content-length"];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return "invalid";
  const length = Number(raw);
  return Number.isSafeInteger(length) ? length : "invalid";
}
