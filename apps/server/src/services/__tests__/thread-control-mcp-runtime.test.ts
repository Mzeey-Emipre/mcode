import "reflect-metadata";
import { request, type Server } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { InternalThreadControlMcpAuthority } from "../thread-control-mcp-authority.js";
import { InternalThreadControlMcpRuntime } from "../thread-control-mcp-runtime.js";

function status(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, { method: "POST" }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    outgoing.once("error", reject);
    outgoing.end();
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
    const port = first?.configOverrides[0].match(/127\.0\.0\.1:(\d+)/)?.[1];
    expect(port).toBeDefined();
    expect(await status(`http://127.0.0.1:${port}/%`)).toBe(401);

    const sessions = (instance as unknown as {
      httpSessions: Map<string, { transport: { close: () => Promise<void> } }>;
    }).httpSessions;
    vi.spyOn(sessions.get("session")!.transport, "close").mockRejectedValueOnce(new Error("transport close failed"));
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
});
