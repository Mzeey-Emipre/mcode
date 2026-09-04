import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { OpenCodeProvider } from "../opencode-provider.js";
import { OpenCodeServerPool } from "../opencode-server-pool.js";
import type { TurnRequest } from "@mcode/contracts";

const IDLE = { type: "session.idle", properties: { sessionID: "ses_1" } };
const TEXT = {
  type: "message.part.updated",
  properties: { sessionID: "ses_1", part: { type: "text", id: "p1" }, delta: "more work" },
};
const ASK = {
  type: "permission.v2.asked",
  properties: { id: "per_1", sessionID: "ses_1", action: "bash", resources: ["echo hi"] },
};

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

function testProvider(http: never) {
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
    pool: testPool(),
    http: http as never,
    probeCli: async () => ({ binaryPath: "opencode", version: "test" }),
    idleConfirm: { intervalMs: 5, requiredPolls: 2, timeoutMs: 500, maxPollErrors: 2 },
  });
  return { provider, submitted };
}

function turnRequest(): TurnRequest<"opencode"> {
  return {
    turnId: "turn-1",
    turnExecutionId: "77777777-7777-4777-8777-777777777777",
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

function endedOutcomes(submitted: unknown[]): unknown[] {
  return submittedEvents(submitted)
    .filter((event) => event.type === "ended")
    .map((event) => event.outcome);
}

/** Open stream: emits scripted envelopes, then stays open until abort. */
function openSubscribe(envelopes: unknown[]) {
  return vi.fn(async (_url: string, signal: AbortSignal, onEnvelope: (e: unknown) => void) => {
    for (const envelope of envelopes) onEnvelope(envelope);
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  });
}

function idleStatus() {
  return vi.fn(async () => new Proxy({}, { get: () => ({ type: "idle" }) }));
}

function fakeHttp(overrides: Record<string, unknown> = {}) {
  return {
    createSession: vi.fn(async () => ({ id: "ses_1" })),
    promptAsync: vi.fn(async () => {}),
    abortSession: vi.fn(async () => {}),
    listModels: vi.fn(async () => []),
    listSessionMessages: vi.fn(async () => []),
    replyPermission: vi.fn(async () => {}),
    replyQuestion: vi.fn(async () => {}),
    rejectQuestion: vi.fn(async () => {}),
    getSessionStatus: idleStatus(),
    subscribeEvents: openSubscribe([IDLE]),
    ...overrides,
  };
}

describe("OpenCodeProvider idle confirmation", () => {
  it("settles completed only after consecutive idle polls", async () => {
    const http = fakeHttp();
    const { provider, submitted } = testProvider(http as never);
    await provider.sendTurn(turnRequest());
    expect(http.getSessionStatus).toHaveBeenCalledTimes(2);
    expect(endedOutcomes(submitted)).toEqual(["completed"]);
    provider.shutdown();
  });

  it("treats a drained session as quiet, not as a poll failure", async () => {
    const http = fakeHttp({ getSessionStatus: vi.fn(async () => ({})) });
    const { provider, submitted } = testProvider(http as never);
    await provider.sendTurn(turnRequest());
    expect(endedOutcomes(submitted)).toEqual(["completed"]);
    provider.shutdown();
  });

  it("restarts confirmation when mapped activity arrives between idles", async () => {
    let emit: ((e: unknown) => void) | null = null;
    // The second poll blocks until the test injects activity: this proves the
    // first confirmation abandons on new work and a fresh idle restarts it.
    let releaseSecondPoll: (() => void) | null = null;
    const secondPollGate = new Promise<void>((resolve) => {
      releaseSecondPoll = resolve;
    });
    let polls = 0;
    const http = fakeHttp({
      getSessionStatus: vi.fn(async () => {
        polls += 1;
        if (polls >= 2) await secondPollGate;
        return { ses_1: { type: "idle" } };
      }),
      subscribeEvents: vi.fn(async (_url: string, signal: AbortSignal, onEnvelope: (e: unknown) => void) => {
        emit = onEnvelope;
        onEnvelope(IDLE);
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }),
    });
    const { provider, submitted } = testProvider(http as never);
    const sending = provider.sendTurn(turnRequest());
    await vi.waitFor(() => expect(polls).toBeGreaterThanOrEqual(1));
    emit!(TEXT);
    emit!(IDLE);
    releaseSecondPoll!();
    await sending;
    expect(endedOutcomes(submitted)).toEqual(["completed"]);
    expect(polls).toBeGreaterThanOrEqual(3);
    provider.shutdown();
  });

  it("abandons confirmation while the session reports busy", async () => {
    let emit: ((e: unknown) => void) | null = null;
    const statuses = [{ type: "busy" }, { type: "idle" }, { type: "idle" }];
    const http = fakeHttp({
      getSessionStatus: vi.fn(async () => ({ ses_1: statuses.shift() ?? { type: "idle" } })),
      subscribeEvents: vi.fn(async (_url: string, signal: AbortSignal, onEnvelope: (e: unknown) => void) => {
        emit = onEnvelope;
        onEnvelope(IDLE);
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }),
    });
    const { provider, submitted } = testProvider(http as never);
    const sending = provider.sendTurn(turnRequest());
    await vi.waitFor(() => expect(http.getSessionStatus).toHaveBeenCalledTimes(1));
    emit!(IDLE);
    await sending;
    expect(endedOutcomes(submitted)).toEqual(["completed"]);
    expect(http.getSessionStatus.mock.calls.length).toBeGreaterThanOrEqual(3);
    provider.shutdown();
  });

  it("never settles while a permission card is pending", async () => {
    let emit: ((e: unknown) => void) | null = null;
    const http = fakeHttp({
      replyPermission: vi.fn(async () => {
        setTimeout(() => emit?.(IDLE), 0);
      }),
      subscribeEvents: vi.fn(async (_url: string, signal: AbortSignal, onEnvelope: (e: unknown) => void) => {
        emit = onEnvelope;
        onEnvelope(ASK);
        onEnvelope(IDLE);
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }),
    });
    const { provider, submitted } = testProvider(http as never);
    const sending = provider.sendTurn(turnRequest());
    await vi.waitFor(() => expect(provider.listPendingPermissions("thread-1")).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(endedOutcomes(submitted)).toEqual([]);
    expect(http.getSessionStatus).not.toHaveBeenCalled();
    expect(provider.resolvePermission("per_1", "allow")).toBe(true);
    await sending;
    expect(endedOutcomes(submitted)).toEqual(["completed"]);
    provider.shutdown();
  });

  it("settles errored after repeated status poll failures", async () => {
    const http = fakeHttp({
      getSessionStatus: vi.fn(async () => {
        throw new Error("connection reset");
      }),
    });
    const { provider, submitted } = testProvider(http as never);
    await provider.sendTurn(turnRequest());
    expect(http.getSessionStatus).toHaveBeenCalledTimes(2);
    const events = submittedEvents(submitted);
    expect(events.filter((event) => event.type === "error")).toHaveLength(1);
    expect(endedOutcomes(submitted)).toEqual(["errored"]);
    provider.shutdown();
  });

  it("aborts a hung status poll when Stop cancels the turn", async () => {
    let statusSignal: AbortSignal | undefined;
    const http = fakeHttp({
      getSessionStatus: vi.fn((_baseUrl: string, options?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
        statusSignal = options?.signal;
        statusSignal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      })),
    });
    const { provider, submitted } = testProvider(http as never);
    const sending = provider.sendTurn(turnRequest());
    await vi.waitFor(() => expect(http.getSessionStatus).toHaveBeenCalledTimes(1));

    await provider.stopSession("mcode-thread-1");
    await sending;

    expect(statusSignal?.aborted).toBe(true);
    expect(endedOutcomes(submitted)).toEqual(["cancelled"]);
    provider.shutdown();
  });

  it("emits one terminal outcome for duplicate idles", async () => {
    const http = fakeHttp({ subscribeEvents: openSubscribe([IDLE, IDLE, IDLE]) });
    const { provider, submitted } = testProvider(http as never);
    await provider.sendTurn(turnRequest());
    expect(endedOutcomes(submitted)).toEqual(["completed"]);
    provider.shutdown();
  });
});
