import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { OpenCodeProvider } from "../opencode-provider.js";
import { OpenCodeServerPool } from "../opencode-server-pool.js";
import { OpenCodeReplySessionNotFoundError } from "../opencode-http-client.js";
import type { PermissionRequest, TurnRequest } from "@mcode/contracts";

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

interface FakeHttp {
  createSession: ReturnType<typeof vi.fn>;
  promptAsync: ReturnType<typeof vi.fn>;
  abortSession: ReturnType<typeof vi.fn>;
  listModels: ReturnType<typeof vi.fn>;
  listSessionMessages: ReturnType<typeof vi.fn>;
  replyPermission: ReturnType<typeof vi.fn>;
  replyQuestion: ReturnType<typeof vi.fn>;
  rejectQuestion: ReturnType<typeof vi.fn>;
  subscribeEvents: ReturnType<typeof vi.fn>;
}

function fakeHttp(envelopes: unknown[], hooks?: { onPrompt?: () => void }): FakeHttp {
  let emit: ((e: unknown) => void) | null = null;
  const idle = { type: "session.idle", properties: { sessionID: "ses_1" } };
  const fake = {
    createSession: vi.fn(async () => ({ id: "ses_1" })),
    promptAsync: vi.fn(async () => {
      hooks?.onPrompt?.();
    }),
    abortSession: vi.fn(async () => {}),
    listModels: vi.fn(async () => []),
    listSessionMessages: vi.fn(async () => []),
    // A relayed decision unblocks the fake upstream: the next step ends idle,
    // which is what lets the turn settle. Scheduled after the relay resolves
    // so the pending entry is already gone when confirmation checks.
    replyPermission: vi.fn(async () => {
      setTimeout(() => emit?.(idle), 0);
    }),
    replyQuestion: vi.fn(async () => {
      setTimeout(() => emit?.(idle), 0);
    }),
    rejectQuestion: vi.fn(async () => {
      setTimeout(() => emit?.(idle), 0);
    }),
    getSessionStatus: vi.fn(async () => new Proxy({}, { get: () => ({ type: "idle" }) })),
    subscribeEvents: vi.fn(async (_url: string, signal: AbortSignal, onEnvelope: (e: unknown) => void) => {
      emit = onEnvelope;
      for (const envelope of envelopes) onEnvelope(envelope);
      // Production streams stay open until abort; returning early would trip
      // the stream-end fallback and mis-settle the turn in tests.
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }),
  };
  return fake;
}

function testProvider(http: FakeHttp) {
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
    turnExecutionId: "55555555-5555-4555-8555-555555555555",
    sessionId: "mcode-thread-1",
    workspaceId: "ws-1",
    threadId: "thread-1",
    message: "run the thing",
    cwd: "/w/a",
    model: "anthropic/claude-sonnet-4-6",
    permissionMode: "supervised",
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

function shellAsk(id = "per_1") {
  return {
    type: "permission.v2.asked",
    properties: { id, sessionID: "ses_1", action: "bash", resources: ["echo hi"] },
  };
}

function questionAsk(id = "que_1") {
  return {
    type: "question.v2.asked",
    properties: {
      id,
      sessionID: "ses_1",
      questions: [
        { header: "Deploy", question: "Deploy now?", options: [{ label: "Yes" }, { label: "No" }] },
        { header: "Region", question: "Which region?", options: [{ label: "East" }] },
      ],
    },
  };
}

describe("OpenCodeProvider permission flow", () => {
  it("cards a shell ask once and relays approve-once exactly once", async () => {
    const http = fakeHttp([shellAsk(), shellAsk()]);
    const { provider, submitted } = testProvider(http);
    const cards: PermissionRequest[] = [];
    provider.on("permission_request", (request) => cards.push(request as PermissionRequest));

    const sending = provider.sendTurn(turnRequest());
    await vi.waitFor(() => expect(cards).toHaveLength(1));

    expect(cards[0]).toEqual({
      requestId: "per_1",
      threadId: "thread-1",
      toolName: "bash",
      input: { action: "bash", resources: ["echo hi"] },
    });
    expect(provider.listPendingPermissions("thread-1")).toHaveLength(1);

    expect(provider.resolvePermission("per_1", "allow")).toBe(true);
    await sending;
    expect(http.replyPermission).toHaveBeenCalledTimes(1);
    expect(http.replyPermission).toHaveBeenCalledWith(
      "http://127.0.0.1:4096", "ses_1", "per_1", "once", "v2", expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(provider.listPendingPermissions("thread-1")).toHaveLength(0);

    expect(provider.resolvePermission("per_1", "allow")).toBe(false);
    expect(http.replyPermission).toHaveBeenCalledTimes(1);
    const outcomes = submittedEvents(submitted)
      .filter((event) => event.type === "ended")
      .map((event) => event.outcome);
    expect(outcomes).toEqual(["completed"]);
    provider.shutdown();
  });

  it("relays reject and resolves unknown ids as false", async () => {
    const http = fakeHttp([shellAsk()]);
    const { provider } = testProvider(http);
    const resolved: unknown[] = [];
    provider.on("permission_resolved", (payload) => resolved.push(payload));

    const sending = provider.sendTurn(turnRequest());
    await vi.waitFor(() => expect(provider.listPendingPermissions("thread-1")).toHaveLength(1));
    expect(provider.resolvePermission("per_1", "deny")).toBe(true);
    await sending;
    expect(http.replyPermission).toHaveBeenCalledWith(
      "http://127.0.0.1:4096", "ses_1", "per_1", "reject", "v2", expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(resolved).toEqual([{ requestId: "per_1", decision: "deny" }]);
    expect(provider.resolvePermission("nope", "allow")).toBe(false);
    provider.shutdown();
  });

  it("relays exact question selections, rejects invalid answers locally, and rejects on deny", async () => {
    const http = fakeHttp([questionAsk("que_1"), questionAsk("que_2")]);
    const { provider } = testProvider(http);
    const cards: PermissionRequest[] = [];
    provider.on("permission_request", (request) => cards.push(request as PermissionRequest));

    const sending = provider.sendTurn(turnRequest());
    await vi.waitFor(() => expect(cards).toHaveLength(2));
    expect(cards.map((card) => card.toolName)).toEqual(["Question", "Question"]);
    expect(cards[0]?.questions).toEqual([
      {
        header: "Deploy",
        question: "Deploy now?",
        options: [{ label: "Yes" }, { label: "No" }],
        multiple: false,
        custom: false,
      },
      {
        header: "Region",
        question: "Which region?",
        options: [{ label: "East" }],
        multiple: false,
        custom: false,
      },
    ]);

    expect(provider.resolvePermission("que_1", "allow")).toBe(false);
    expect(provider.resolvePermission("que_1", "allow", [["Yes", "No"], ["East"]])).toBe(false);
    expect(provider.resolvePermission("que_1", "allow-session", [["Yes"], ["East"]])).toBe(false);
    expect(http.replyQuestion).not.toHaveBeenCalled();
    expect(provider.listPendingPermissions("thread-1")).toHaveLength(2);

    expect(provider.resolvePermission("que_1", "allow", [["Yes"], ["East"]])).toBe(true);
    await vi.waitFor(() => expect(http.replyQuestion).toHaveBeenCalledTimes(1));
    expect(http.replyQuestion).toHaveBeenCalledWith(
      "http://127.0.0.1:4096",
      "ses_1",
      "que_1",
      [["Yes"], ["East"]],
      "v2",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(provider.resolvePermission("que_1", "allow", [["Yes"], ["East"]])).toBe(false);

    expect(provider.resolvePermission("que_2", "deny")).toBe(true);
    expect(provider.resolvePermission("que_2", "deny")).toBe(false);
    await sending;
    expect(http.rejectQuestion).toHaveBeenCalledWith(
      "http://127.0.0.1:4096", "ses_1", "que_2", "v2", expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(http.rejectQuestion).toHaveBeenCalledTimes(1);
    provider.shutdown();
  });

  it("keeps a failed reply answerable instead of stalling the turn", async () => {
    const http = fakeHttp([shellAsk()]);
    http.replyPermission.mockRejectedValueOnce(new Error("connection reset"));
    const { provider } = testProvider(http);

    const sending = provider.sendTurn(turnRequest());
    await vi.waitFor(() => expect(provider.listPendingPermissions("thread-1")).toHaveLength(1));
    expect(provider.resolvePermission("per_1", "allow")).toBe(true);
    await vi.waitFor(() => expect(http.replyPermission).toHaveBeenCalledTimes(1));
    expect(provider.listPendingPermissions("thread-1")).toHaveLength(1);

    expect(provider.resolvePermission("per_1", "allow")).toBe(true);
    await sending;
    expect(http.replyPermission).toHaveBeenCalledTimes(2);
    expect(provider.listPendingPermissions("thread-1")).toHaveLength(0);
    provider.shutdown();
  });

  it("drains pending cards as cancelled on stop", async () => {
    const http = fakeHttp([]);
    http.subscribeEvents.mockImplementationOnce(
      async (_url: string, signal: AbortSignal, onEnvelope: (e: unknown) => void) => {
        onEnvelope(shellAsk());
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    );
    const { provider } = testProvider(http);
    const resolved: unknown[] = [];
    provider.on("permission_resolved", (payload) => resolved.push(payload));

    const sending = provider.sendTurn(turnRequest());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(provider.listPendingPermissions("thread-1")).toHaveLength(1);
    await provider.stopSession("mcode-thread-1");
    await sending;
    expect(resolved).toEqual([{ requestId: "per_1", decision: "cancelled" }]);
    expect(provider.listPendingPermissions("thread-1")).toHaveLength(0);
    provider.shutdown();
  });

  it("cancels an in-flight reply without a second local settlement", async () => {
    const http = fakeHttp([shellAsk()]);
    let replySignal: AbortSignal | undefined;
    http.replyPermission.mockImplementationOnce((
      _baseUrl: string,
      _sessionId: string,
      _permissionId: string,
      _response: string,
      _version: string,
      options?: { signal?: AbortSignal },
    ) => new Promise<void>((_resolve, reject) => {
      replySignal = options?.signal;
      replySignal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const { provider } = testProvider(http);
    const resolved: unknown[] = [];
    provider.on("permission_resolved", (payload) => resolved.push(payload));

    const sending = provider.sendTurn(turnRequest());
    await vi.waitFor(() => expect(provider.listPendingPermissions("thread-1")).toHaveLength(1));
    expect(provider.resolvePermission("per_1", "allow")).toBe(true);
    await vi.waitFor(() => expect(http.replyPermission).toHaveBeenCalledTimes(1));

    await provider.stopSession("mcode-thread-1");
    await sending;

    expect(replySignal?.aborted).toBe(true);
    expect(resolved).toEqual([{ requestId: "per_1", decision: "cancelled" }]);
    expect(provider.resolvePermission("per_1", "allow")).toBe(false);
    expect(http.replyPermission).toHaveBeenCalledTimes(1);
    provider.shutdown();
  });

  it("drains a replayed ask after stream termination so it can card again", async () => {
    const http = fakeHttp([shellAsk()]);
    http.subscribeEvents.mockImplementationOnce(async (_url: string, _signal: AbortSignal, onEnvelope: (e: unknown) => void) => {
      onEnvelope(shellAsk());
    });
    const { provider } = testProvider(http);
    const resolved: unknown[] = [];
    const cards: PermissionRequest[] = [];
    provider.on("permission_resolved", (payload) => resolved.push(payload));
    provider.on("permission_request", (request) => cards.push(request as PermissionRequest));

    await provider.sendTurn(turnRequest());

    expect(resolved).toEqual([{ requestId: "per_1", decision: "cancelled" }]);
    expect(provider.listPendingPermissions("thread-1")).toHaveLength(0);
    const retry = provider.sendTurn({ ...turnRequest(), turnId: "turn-2", turnExecutionId: "66666666-6666-4666-8666-666666666666" });
    await vi.waitFor(() => expect(cards).toHaveLength(2));
    await provider.stopSession("mcode-thread-1");
    await retry;
    expect(resolved).toEqual([
      { requestId: "per_1", decision: "cancelled" },
      { requestId: "per_1", decision: "cancelled" },
    ]);
    provider.shutdown();
  });

  it("drains a pending ask on provider failure and shutdown", async () => {
    const http = fakeHttp([shellAsk()]);
    http.promptAsync.mockRejectedValueOnce(new Error("provider failed"));
    const { provider } = testProvider(http);
    const resolved: unknown[] = [];
    provider.on("permission_resolved", (payload) => resolved.push(payload));

    await provider.sendTurn(turnRequest());
    expect(resolved).toEqual([{ requestId: "per_1", decision: "cancelled" }]);

    const retry = provider.sendTurn({ ...turnRequest(), turnId: "turn-2", turnExecutionId: "66666666-6666-4666-8666-666666666666" });
    await vi.waitFor(() => expect(provider.listPendingPermissions("thread-1")).toHaveLength(1));
    provider.shutdown();
    await retry;
    expect(resolved).toEqual([
      { requestId: "per_1", decision: "cancelled" },
      { requestId: "per_1", decision: "cancelled" },
    ]);
  });

  it("invalidates a typed missing reply session instead of resolving approval", async () => {
    const http = fakeHttp([shellAsk()]);
    http.replyPermission.mockRejectedValueOnce(new OpenCodeReplySessionNotFoundError());
    const { provider, submitted } = testProvider(http);
    const resolved: unknown[] = [];
    provider.on("permission_resolved", (payload) => resolved.push(payload));

    const sending = provider.sendTurn(turnRequest());
    await vi.waitFor(() => expect(provider.listPendingPermissions("thread-1")).toHaveLength(1));
    expect(provider.resolvePermission("per_1", "allow")).toBe(true);
    await sending;

    expect(resolved).toEqual([{ requestId: "per_1", decision: "cancelled" }]);
    const events = submittedEvents(submitted);
    expect(events.filter((event) => event.type === "system" && event.subtype === "sdk_session_invalidated")).toHaveLength(1);
    expect(events.filter((event) => event.type === "ended").map((event) => event.outcome)).toEqual(["cancelled"]);
    provider.shutdown();
  });
});

describe("OpenCodeProvider notice dedup", () => {
  it("shows each diagnostic and notice once across reconnects", async () => {
    const unknown = { type: "session.frobnicate", properties: { sessionID: "ses_1" } };
    const reroute = {
      type: "session.next.model.switched",
      properties: { sessionID: "ses_1", model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" } },
    };
    const idle = { type: "session.idle", properties: { sessionID: "ses_1" } };
    const http = fakeHttp([unknown, reroute, idle]);
    const { provider, submitted } = testProvider(http);

    await provider.sendTurn(turnRequest());
    await provider.sendTurn({ ...turnRequest(), turnId: "turn-2", turnExecutionId: "66666666-6666-4666-8666-666666666666" });

    const events = submittedEvents(submitted);
    expect(events.filter((event) => event.type === "system" && event.subtype === "provider.notice.unknown-event")).toHaveLength(1);
    expect(events.filter((event) => (
      event.type === "modelFallback"
      && event.requestedModel === "anthropic/claude-sonnet-4-6"
      && event.actualModel === "anthropic/claude-sonnet-4-6"
    ))).toHaveLength(1);
    provider.shutdown();
  });

  it("surfaces one diagnostic row for a malformed ask without carding", async () => {
    const http = fakeHttp([
      { type: "permission.v2.asked", properties: { sessionID: "ses_1" } },
      { type: "permission.v2.asked", properties: { sessionID: "ses_1" } },
      { type: "session.idle", properties: { sessionID: "ses_1" } },
    ]);
    const { provider, submitted } = testProvider(http);
    const cards: PermissionRequest[] = [];
    provider.on("permission_request", (request) => cards.push(request as PermissionRequest));

    await provider.sendTurn(turnRequest());
    expect(cards).toHaveLength(0);
    const subtypes = submittedEvents(submitted)
      .filter((event) => event.type === "system")
      .map((event) => event.subtype);
    expect(subtypes.filter((subtype) => subtype === "provider.notice.malformed-request")).toHaveLength(1);
    provider.shutdown();
  });
});
