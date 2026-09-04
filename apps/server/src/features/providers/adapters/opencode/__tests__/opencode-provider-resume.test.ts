import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { OpenCodeProvider } from "../opencode-provider.js";
import { OpenCodeServerPool } from "../opencode-server-pool.js";
import type { TurnRequest } from "@mcode/contracts";

function testPool(): OpenCodeServerPool {
  return new OpenCodeServerPool({
    spawn: () => ({ pid: 1, on: () => {}, off: () => {}, kill: () => true }) as never,
    waitForHealth: async () => {},
    terminateTree: async () => {},
    findFreePort: async () => 4096,
    now: () => Date.now(),
    env: () => ({}),
  });
}

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

function turnRequest(overrides: Partial<TurnRequest<"opencode">> = {}): TurnRequest<"opencode"> {
  return {
    turnId: "turn-1",
    turnExecutionId: "22222222-2222-4222-8222-222222222222",
    sessionId: "mcode-thread-1",
    workspaceId: "ws-1",
    threadId: "thread-1",
    message: "hello again",
    cwd: "/w/a",
    model: "anthropic/claude-sonnet-4-6",
    permissionMode: "full",
    interactionMode: "build",
    providerOptions: {},
    ...overrides,
  } as TurnRequest<"opencode">;
}

/** Unwrap canonical runtime events out of submitted ingress batches. */
function submittedEvents(submitted: unknown[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const batch of submitted) {
    const events = (batch as { events?: Array<{ payload?: unknown }> }).events ?? [];
    for (const draft of events) {
      const payload = draft?.payload as {
        item?: { payload?: { runtimeEvent?: { event?: Record<string, unknown> } } };
      } | undefined;
      const event = payload?.item?.payload?.runtimeEvent?.event;
      if (event) out.push(event);
    }
  }
  return out;
}

function fakeHttp(scenarios: {
  createId?: string;
  createdIds?: string[];
  verify?: (sessionId: string) => Promise<unknown[]>;
  prompt?: (sessionId: string) => Promise<void>;
}) {
  let created = 0;
  return {
    createSession: vi.fn(async () => {
      created += 1;
      return { id: scenarios.createdIds?.[created - 1] ?? scenarios.createId ?? `ses_fresh_${created}` };
    }),
    listSessionMessages: vi.fn(async (_url: string, sessionId: string) =>
      scenarios.verify ? scenarios.verify(sessionId) : []),
    promptAsync: vi.fn(async (_url: string, sessionId: string) => {
      await scenarios.prompt?.(sessionId);
    }),
    abortSession: vi.fn(async () => {}),
    listModels: vi.fn(async () => []),
    subscribeEvents: vi.fn(async (_url: string, _signal: AbortSignal, onEnvelope: (e: unknown) => void) => {
      onEnvelope({ type: "session.idle", properties: { sessionID: "ses_any" } });
    }),
  };
}

describe("OpenCodeProvider resume cursor", () => {
  it("re-adopts resumeFrom on cold state without creating a session (restart resume)", async () => {
    const http = fakeHttp({});
    const { provider, submitted } = testProvider(http as never, testPool());
    await provider.sendTurn(turnRequest({ resumeFrom: "ses_kept" }));
    expect(http.createSession).not.toHaveBeenCalled();
    expect(http.promptAsync).toHaveBeenCalledWith("http://127.0.0.1:4096", "ses_kept", expect.anything());
    const events = submittedEvents(submitted);
    expect(events).toContainEqual(expect.objectContaining({ subtype: "sdk_session_id:ses_kept" }));
    provider.shutdown();
  });

  it("ignores an unknown cursor version and starts fresh", async () => {
    const http = fakeHttp({ createId: "ses_brand_new" });
    const { provider } = testProvider(http as never, testPool());
    await provider.sendTurn(turnRequest({
      resumeFrom: JSON.stringify({ schemaVersion: 99, sessionId: "ses_kept" }),
    }));
    expect(http.createSession).toHaveBeenCalledTimes(1);
    expect(http.promptAsync).toHaveBeenCalledWith("http://127.0.0.1:4096", "ses_brand_new", expect.anything());
    provider.shutdown();
  });

  it("starts fresh with a visible notice when the adopted session is gone (deleted upstream)", async () => {
    const http = fakeHttp({
      createdIds: ["ses_fresh_1"],
      verify: async (sessionId) => {
        if (sessionId === "ses_gone") throw new Error("OpenCode session history failed with HTTP 404");
        return [];
      },
    });
    const { provider, submitted } = testProvider(http as never, testPool());
    await provider.sendTurn(turnRequest({ resumeFrom: "ses_gone" }));
    expect(http.createSession).toHaveBeenCalledTimes(1);
    expect(http.promptAsync).toHaveBeenCalledWith("http://127.0.0.1:4096", "ses_fresh_1", expect.anything());
    const events = submittedEvents(submitted);
    expect(events).toContainEqual(expect.objectContaining({
      type: "system",
      subtype: expect.stringContaining("session-recreated"),
    }));
    provider.shutdown();
  });

  it("starts fresh with a visible notice on a prompt-time 404 race", async () => {
    const http = fakeHttp({
      createdIds: ["ses_fresh_2"],
      prompt: async (sessionId) => {
        if (sessionId === "ses_race_gone") throw new Error("OpenCode prompt_async failed with HTTP 404");
      },
    });
    const { provider, submitted } = testProvider(http as never, testPool());
    await provider.sendTurn(turnRequest({ resumeFrom: "ses_race_gone" }));
    expect(http.createSession).toHaveBeenCalledTimes(1);
    const events = submittedEvents(submitted);
    expect(events).toContainEqual(expect.objectContaining({
      type: "system",
      subtype: expect.stringContaining("session-recreated"),
    }));
    provider.shutdown();
  });

  it("leaves other threads alone when one upstream session is recreated", async () => {
    const http = fakeHttp({
      createdIds: ["ses_fresh_other"],
      verify: async (sessionId) => {
        if (sessionId === "ses_gone") throw new Error("OpenCode session history failed with HTTP 404");
        return [];
      },
    });
    const { provider } = testProvider(http as never, testPool());
    await provider.sendTurn(turnRequest({ resumeFrom: "ses_a" }));
    await provider.sendTurn(turnRequest({
      sessionId: "mcode-thread-2",
      threadId: "thread-2",
      turnId: "turn-2",
      turnExecutionId: "33333333-3333-4333-8333-333333333333",
      resumeFrom: "ses_gone",
    }));
    await provider.sendTurn(turnRequest({
      turnId: "turn-3",
      turnExecutionId: "44444444-4444-4344-8344-444444444444",
    }));
    expect(http.createSession).toHaveBeenCalledTimes(1);
    const prompted = http.promptAsync.mock.calls.map(([, sessionId]) => sessionId);
    expect(prompted).toEqual(["ses_a", "ses_fresh_other", "ses_a"]);
    provider.shutdown();
  });

  it("only a confirmed 404 starts fresh; other verify failures propagate without reset", async () => {
    const http = fakeHttp({
      verify: async () => {
        throw new Error("boom: connection refused");
      },
    });
    const { provider } = testProvider(http as never, testPool());
    await provider.sendTurn(turnRequest({ resumeFrom: "ses_live" }));
    expect(http.createSession).not.toHaveBeenCalled();
    expect(http.promptAsync).not.toHaveBeenCalled();
    provider.shutdown();
  });
});
