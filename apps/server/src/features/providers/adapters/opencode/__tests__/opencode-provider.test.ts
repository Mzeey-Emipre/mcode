import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { OpenCodeProvider, toOpenCodeModelRef } from "../opencode-provider.js";
import { OpenCodeServerPool } from "../opencode-server-pool.js";
import type { TurnRequest } from "@mcode/contracts";

function testProvider(http: never, pool: OpenCodeServerPool) {
  const settingsService = { get: () => ({ provider: { cli: { opencode: "opencode" } } }) };
  const envService = { getEnv: () => ({}) };
  const submitted: unknown[] = [];
  const host = {
    events: { submit: async (batch: unknown) => { submitted.push(batch); return { commit: {}, delivery: { ingress: "queued" } }; } },
    processes: { attach: () => {}, terminateTree: async () => {} },
    runtime: { platform: "win32" },
    environment: { snapshot: () => ({}) },
    browser: {},
    threadControl: {},
    grants: {},
  };
  const provider = new OpenCodeProvider(settingsService as never, envService as never, host as never);
  provider.configureTestSeams({
    pool,
    http: http as never,
    probeCli: async () => ({ binaryPath: "opencode", version: "test" }),
  });
  return { provider, submitted };
}

function turnRequest(): TurnRequest<"opencode"> {
  return {
    turnId: "turn-1",
    turnExecutionId: "11111111-1111-4111-8111-111111111111",
    sessionId: "mcode-thread-1",
    workspaceId: "ws-1",
    threadId: "thread-1",
    message: "hello",
    cwd: "/w/a",
    model: "anthropic/claude-sonnet-4-6",
    permissionMode: "full",
    interactionMode: "build",
    providerOptions: {},
  } as TurnRequest<"opencode">;
}

describe("toOpenCodeModelRef", () => {
  it("splits provider/model slugs", () => {
    expect(toOpenCodeModelRef("opencode/muse-spark-1.3-contributor-free")).toEqual({
      providerID: "opencode",
      modelID: "muse-spark-1.3-contributor-free",
    });
  });

  it("passes bare ids as model-only and blanks as undefined", () => {
    expect(toOpenCodeModelRef("gpt-5")).toEqual({ modelID: "gpt-5" });
    expect(toOpenCodeModelRef("  ")).toBeUndefined();
    expect(toOpenCodeModelRef(undefined)).toBeUndefined();
  });
});

describe("OpenCodeProvider minimal turn", () => {
  it("streams a reply to completion and returns the pool server warm", async () => {
    const pool = new OpenCodeServerPool({
      spawn: () => ({ pid: 1, on: () => {}, off: () => {}, kill: () => true }) as never,
      waitForHealth: async () => {},
      terminateTree: async () => {},
      findFreePort: async () => 4096,
      now: () => Date.now(),
      env: () => ({}),
    });
    const http = {
      createSession: vi.fn(async () => ({ id: "ses_1" })),
      promptAsync: vi.fn(async () => {}),
      abortSession: vi.fn(async () => {}),
      listModels: vi.fn(async () => []),
      subscribeEvents: vi.fn(async (_url: string, _signal: AbortSignal, onEnvelope: (e: unknown) => void) => {
        onEnvelope({ type: "message.part.updated", properties: { sessionID: "ses_1", part: { type: "text", id: "p1" }, delta: "hi" } });
        onEnvelope({ type: "session.idle", properties: { sessionID: "ses_1" } });
      }),
    };
    const { provider, submitted } = testProvider(http as never, pool);
    const events: unknown[] = [];
    provider.on("event", (e) => events.push(e));
    await provider.sendTurn(turnRequest());
    expect(http.createSession).toHaveBeenCalledTimes(1);
    expect(http.promptAsync).toHaveBeenCalledTimes(1);
    expect(http.promptAsync).toHaveBeenCalledWith("http://127.0.0.1:4096", "ses_1", {
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      parts: [{ type: "text", text: "hello" }],
    });
    expect(pool.size).toBe(1);
    expect(submitted.length).toBeGreaterThan(0);
    provider.shutdown();
  });

  it("stop aborts the upstream session and settles as cancelled with no further output", async () => {
    let captured: ((e: unknown) => void) | null = null;
    const pool = new OpenCodeServerPool({
      spawn: () => ({ pid: 1, on: () => {}, off: () => {}, kill: () => true }) as never,
      waitForHealth: async () => {},
      terminateTree: async () => {},
      findFreePort: async () => 4096,
      now: () => Date.now(),
      env: () => ({}),
    });
    const http = {
      createSession: vi.fn(async () => ({ id: "ses_9" })),
      promptAsync: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 50));
      }),
      abortSession: vi.fn(async () => {}),
      listModels: vi.fn(async () => []),
      subscribeEvents: vi.fn(async (_url: string, signal: AbortSignal, onEnvelope: (e: unknown) => void) => {
        captured = onEnvelope;
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }),
    };
    const { provider } = testProvider(http as never, pool);
    const sending = provider.sendTurn(turnRequest());
    await new Promise((r) => setTimeout(r, 10));
    await provider.stopSession("mcode-thread-1");
    captured?.({ type: "message.part.updated", properties: { sessionID: "ses_9", part: { type: "text", id: "p1" }, delta: "late" } });
    await sending;
    expect(http.abortSession).toHaveBeenCalledTimes(1);
    expect(pool.size).toBe(1);
    provider.shutdown();
  });

  it("starts fresh once when the adopted upstream session is gone (404)", async () => {
    const pool = new OpenCodeServerPool({
      spawn: () => ({ pid: 1, on: () => {}, off: () => {}, kill: () => true }) as never,
      waitForHealth: async () => {},
      terminateTree: async () => {},
      findFreePort: async () => 4096,
      now: () => Date.now(),
      env: () => ({}),
    });
    let sessions = 0;
    const http = {
      createSession: vi.fn(async () => ({ id: `ses_fresh_${++sessions}` })),
      promptAsync: vi.fn(async (_url: string, sessionId: string) => {
        if (sessionId === "ses_stale") throw new Error("OpenCode prompt_async failed with HTTP 404");
      }),
      abortSession: vi.fn(async () => {}),
      listModels: vi.fn(async () => []),
      subscribeEvents: vi.fn(async (_url: string, _signal: AbortSignal, onEnvelope: (e: unknown) => void) => {
        onEnvelope({ type: "session.idle", properties: { sessionID: `ses_fresh_${sessions}` } });
      }),
    };
    const { provider } = testProvider(http as never, pool);
    await provider.sendTurn(turnRequest());
    // First turn adopts and caches ses_fresh_1.
    await provider.sendTurn(turnRequest());
    expect(http.createSession).toHaveBeenCalledTimes(1);
    // Simulate the cached session disappearing upstream, then send again:
    // the provider must recreate once instead of erroring.
    (provider as unknown as { turns: Map<string, { upstreamSessionId: string }> })
      .turns.get("mcode-thread-1")!.upstreamSessionId = "ses_stale";
    await provider.sendTurn(turnRequest());
    expect(http.createSession).toHaveBeenCalledTimes(2);
    provider.shutdown();
  });

  it("discardSession drops the adopted upstream session", async () => {
    const pool = new OpenCodeServerPool({
      spawn: () => ({ pid: 1, on: () => {}, off: () => {}, kill: () => true }) as never,
      waitForHealth: async () => {},
      terminateTree: async () => {},
      findFreePort: async () => 4096,
      now: () => Date.now(),
      env: () => ({}),
    });
    const http = {
      createSession: vi.fn(async () => ({ id: "ses_1" })),
      promptAsync: vi.fn(async () => {}),
      abortSession: vi.fn(async () => {}),
      listModels: vi.fn(async () => []),
      subscribeEvents: vi.fn(async (_url: string, _signal: AbortSignal, onEnvelope: (e: unknown) => void) => {
        onEnvelope({ type: "session.idle", properties: { sessionID: "ses_1" } });
      }),
    };
    const { provider } = testProvider(http as never, pool);
    await provider.sendTurn(turnRequest());
    await provider.discardSession("mcode-thread-1");
    await provider.sendTurn(turnRequest());
    expect(http.createSession).toHaveBeenCalledTimes(2);
    provider.shutdown();
  });
});
