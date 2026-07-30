import "reflect-metadata";
import { request, type Server } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InternalThreadControlMcpAuthority } from "../thread-control-mcp-authority.js";
import {
  INTERNAL_MCP_REQUEST_TIMEOUT_MS,
  MAX_INTERNAL_MCP_REQUEST_BODY_BYTES,
  InternalThreadControlMcpRuntime,
} from "../thread-control-mcp-runtime.js";

function status(url: string, options: { headers?: Record<string, string>; body?: Buffer } = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, { method: "POST", headers: options.headers }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    outgoing.once("error", reject);
    outgoing.end(options.body);
  });
}

function runtime(): { runtime: InternalThreadControlMcpRuntime; authority: InternalThreadControlMcpAuthority } {
  const authority = new InternalThreadControlMcpAuthority();
  const instance = new InternalThreadControlMcpRuntime({} as never, authority);
  return { runtime: instance, authority };
}

describe("InternalThreadControlMcpRuntime", () => {
  it("shares one startup listener and rejects malformed session encoding", async () => {
    const { runtime: instance, authority } = runtime();
    const lease = authority.activate({
      sessionId: "session",
      sourceThreadId: "thread",
      sourceTurnId: "turn",
      sourceProviderId: "codex",
      permissionMode: "full",
    });

    const [first, second] = await Promise.all([
      instance.createCodexConfiguration("session"),
      instance.createCodexConfiguration("session"),
    ]);

    expect(first?.configOverrides).toEqual(second?.configOverrides);
    const connection = await instance.createHttpConnection("session");
    expect(connection?.name).toBe("mcode_internal_thread_control");
    expect(connection?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/session$/);
    expect(connection?.headers.Authorization).toMatch(/^Bearer /);
    const port = first?.configOverrides[0].match(/127\.0\.0\.1:(\d+)/)?.[1];
    expect(port).toBeDefined();
    expect(await status(`http://127.0.0.1:${port}/%`)).toBe(401);

    const sessions = (instance as unknown as {
      httpSessions: Map<string, { clients: Map<string, { transport: { close: () => Promise<void> } }> }>;
    }).httpSessions;
    const transport = { close: vi.fn().mockRejectedValueOnce(new Error("transport close failed")) };
    sessions.get("session")!.clients.set("test-client", { transport });
    await expect(instance.close("session")).resolves.toBeUndefined();
    expect(authority.authorize(lease.credential, "call")).toBeUndefined();

    authority.activate({
      sessionId: "session",
      sourceThreadId: "thread",
      sourceTurnId: "turn",
      sourceProviderId: "codex",
      permissionMode: "full",
    });
    await expect(instance.createCodexConfiguration("session")).resolves.toBeDefined();
    await instance.close("session");
  });

  it("releases the shared HTTP session when the pooled provider closes", async () => {
    const { runtime: instance, authority } = runtime();
    authority.activate({
      sessionId: "session",
      sourceThreadId: "thread",
      sourceTurnId: "turn",
      sourceProviderId: "cursor",
      permissionMode: "full",
    });
    await expect(instance.createHttpConnection("session")).resolves.toBeDefined();
    const sessions = (instance as unknown as {
      httpSessions: Map<string, unknown>;
    }).httpSessions;
    expect(sessions.has("session")).toBe(true);
    await instance.close("session");
    expect(sessions.has("session")).toBe(false);
    expect(authority.credential("session")).toBeUndefined();
  });

  it("supports concurrent and reconnecting authenticated MCP clients", async () => {
    const { runtime: instance, authority } = runtime();
    authority.activate({
      sessionId: "session",
      sourceThreadId: "thread",
      sourceTurnId: "turn",
      sourceProviderId: "codex",
      permissionMode: "full",
    });
    const connection = await instance.createHttpConnection("session");
    expect(connection).toBeDefined();
    const createClient = () => {
      const client = new Client({ name: "mcode-runtime-test", version: "0.1.0" });
      const transport = new StreamableHTTPClientTransport(new URL(connection!.url), {
        requestInit: { headers: connection!.headers },
      });
      return { client, transport };
    };
    const first = createClient();
    const second = createClient();
    const reconnect = createClient();

    try {
      await Promise.all([first.client.connect(first.transport), second.client.connect(second.transport)]);
      const [firstTools, secondTools] = await Promise.all([first.client.listTools(), second.client.listTools()]);
      for (const listed of [firstTools, secondTools]) {
        expect(listed.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
          "workspace_search",
          "thread_create_batch",
        ]));
      }
      await first.client.close();
      await reconnect.client.connect(reconnect.transport);
      const reconnectedTools = await reconnect.client.listTools();
      expect(reconnectedTools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        "workspace_search",
        "thread_create_batch",
      ]));
      const unknownSession = await fetch(connection!.url, {
        method: "POST",
        headers: { ...connection!.headers, "mcp-session-id": "unknown-session" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      expect(unknownSession.status).toBe(404);
    } finally {
      await first.client.close().catch(() => undefined);
      await second.client.close().catch(() => undefined);
      await reconnect.client.close().catch(() => undefined);
      await instance.close("session");
    }
  });

  it("does not retain a loopback listener when close wins during startup", async () => {
    const { runtime: instance, authority } = runtime();
    authority.activate({
      sessionId: "session",
      sourceThreadId: "thread",
      sourceTurnId: "turn",
      sourceProviderId: "codex",
      permissionMode: "full",
    });
    let finishStartup!: () => void;
    const startup = new Promise<void>((resolve) => {
      finishStartup = resolve;
    });
    const server = { close: vi.fn((callback: () => void) => callback()) };
    vi.spyOn(instance as unknown as { startHttpServer: () => Promise<void> }, "startHttpServer").mockImplementation(async () => {
      await startup;
      const state = instance as unknown as { httpServer: typeof server; httpPort: number };
      state.httpServer = server;
      state.httpPort = 1234;
    });

    const config = instance.createCodexConfiguration("session");
    const close = instance.close("session");
    finishStartup();

    await expect(config).resolves.toBeUndefined();
    await expect(close).resolves.toBeUndefined();
    const state = instance as unknown as { httpServer: Server | undefined; httpSessions: Map<string, unknown> };
    expect(server.close).toHaveBeenCalledOnce();
    expect(state.httpServer).toBeUndefined();
    expect(state.httpSessions).toHaveLength(0);
  });

  it("rejects oversized declared and streamed request bodies before MCP dispatch", async () => {
    const { runtime: instance, authority } = runtime();
    const lease = authority.activate({
      sessionId: "bounded",
      sourceThreadId: "thread",
      sourceTurnId: "turn",
      sourceProviderId: "codex",
      permissionMode: "full",
    });
    const connection = await instance.createHttpConnection("bounded");
    const oversized = await status(connection!.url, {
      headers: {
        ...connection!.headers,
        "content-length": String(MAX_INTERNAL_MCP_REQUEST_BODY_BYTES + 1),
      },
    });
    expect(oversized).toBe(413);

    const streamed = await new Promise<number>((resolve, reject) => {
      const outgoing = request(connection!.url, {
        method: "POST",
        headers: {
          ...connection!.headers,
          Accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "transfer-encoding": "chunked",
        },
      }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      });
      outgoing.once("error", (error) => reject(error));
      outgoing.write(Buffer.alloc(MAX_INTERNAL_MCP_REQUEST_BODY_BYTES, 0x20));
      outgoing.end(Buffer.from("{}"));
    });
    expect(streamed).toBe(413);

    const state = instance as unknown as { httpServer: Server & { requestTimeout: number; headersTimeout: number; timeout: number } };
    expect(state.httpServer.requestTimeout).toBe(INTERNAL_MCP_REQUEST_TIMEOUT_MS);
    expect(state.httpServer.headersTimeout).toBe(INTERNAL_MCP_REQUEST_TIMEOUT_MS);
    expect(state.httpServer.timeout).toBe(INTERNAL_MCP_REQUEST_TIMEOUT_MS);
    expect(authority.credential("bounded")).toBe(lease.credential);
    await instance.close("bounded");
  });
});
