import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { ClientSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import { getDefaultSettings, type TurnRequest } from "@mcode/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ProviderHostPorts } from "../../../host-ports.js";
import { AcpSessionRuntime, SessionRecoveryFailedError } from "../../protocols/acp/acp-session-runtime.js";
import type { CursorSessionState } from "../cursor-session-state.js";
import { CursorProvider } from "../cursor-provider.js";

type FakeRuntime = {
  runtime: AcpSessionRuntime;
  child: ChildProcess;
  connection: ClientSideConnection & { newSession: ReturnType<typeof vi.fn> };
};

function createHost(): ProviderHostPorts {
  return {
    environment: { snapshot: vi.fn(() => ({})) },
    processes: {
      attach: vi.fn(),
      terminateTree: vi.fn(async () => undefined),
    },
    browser: {
      stage: vi.fn(() => ({ leaseId: "lease", expiresAt: Date.now() + 60_000 })),
      releaseSession: vi.fn(() => 0),
      isConfigured: vi.fn(() => false),
      issue: vi.fn(() => null),
      refresh: vi.fn(() => ({ ok: false as const, leaseId: "lease", reason: "unconfigured" as const })),
      release: vi.fn(() => ({ leaseId: "lease", released: false })),
      revokeCredential: vi.fn(() => false),
    },
    threadControl: {
      bootstrap: vi.fn(async () => null),
      close: vi.fn(async () => undefined),
    },
    grants: { consume: vi.fn(() => false) },
    events: {
      submit: vi.fn(async () => ({
        commit: {
          outcome: "committed" as const,
          conversationRevision: 1,
          rosterRevision: 1,
          acceptedThrough: 1,
          durableThrough: 1,
          eventCount: 1,
        },
        delivery: { ingress: "queued" as const },
      })),
    },
  };
}

function createFakeRuntime(sessionId: string, pid: number): FakeRuntime {
  const child = Object.assign(new EventEmitter(), {
    pid,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
  }) as unknown as ChildProcess;
  const connection = {
    newSession: vi.fn(async () => ({ sessionId })),
    unstable_setSessionModel: vi.fn(async () => ({})),
  } as unknown as FakeRuntime["connection"];
  const state = {
    child,
    connection,
    sessionId: "",
    agentCapabilities: {},
    activePrompt: null,
  };
  const runtime = {
    state,
    initialize: vi.fn(async () => ({ agentCapabilities: {}, authMethods: [] })),
    openSession: vi.fn(async ({ resumeFrom }: { resumeFrom?: string }) => {
      if (resumeFrom) {
        state.sessionId = resumeFrom;
        return { sessionId: resumeFrom, reloaded: true };
      }
      const created = await connection.newSession({});
      state.sessionId = created.sessionId;
      return { sessionId: created.sessionId, reloaded: false };
    }),
    prompt: vi.fn(async () => ({ stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } })),
    cancel: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  } as unknown as AcpSessionRuntime;
  return { runtime, child, connection };
}

function turn(message: string, execution: string, resumeFrom?: string): TurnRequest<"cursor"> {
  return {
    turnId: `turn-${execution}`,
    turnExecutionId: execution,
    sessionId: "mcode-thread-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    message,
    cwd: ".",
    model: "cursor-model",
    permissionMode: "default",
    interactionMode: "build",
    providerOptions: {},
    ...(resumeFrom ? { resumeFrom } : {}),
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((done) => {
      resolve = done;
    }),
    resolve,
  };
}

function submittedRuntimeEvents(host: ProviderHostPorts): unknown[] {
  return vi.mocked(host.events.submit).mock.calls.flatMap(([batch]) =>
    batch.events.map((draft) =>
      (draft.payload as { item: { payload: { runtimeEvent: { event: unknown } } } }).item.payload.runtimeEvent.event,
    ),
  );
}

describe("CursorProvider session continuity", () => {
  it("reuses a healthy ACP child for normal turns and replaces it only for an explicit fresh session", async () => {
    const host = createHost();
    const first = createFakeRuntime("cursor-session-1", 101);
    const second = createFakeRuntime("cursor-session-2", 202);
    const runtimes = [first.runtime, second.runtime];
    const start = vi.spyOn(AcpSessionRuntime, "start").mockImplementation(async () => {
      const runtime = runtimes.shift();
      if (!runtime) throw new Error("Unexpected Cursor ACP spawn");
      return runtime;
    });
    const provider = new CursorProvider(host, {
      settings: { get: () => getDefaultSettings() },
      skills: { list: () => [] },
    }, 60_000);

    try {
      await provider.sendTurn(turn("first prompt", "execution-1"));
      await provider.sendTurn(turn("second prompt", "execution-2", "cursor-session-1"));

      expect(start).toHaveBeenCalledTimes(1);
      expect(first.connection.newSession).toHaveBeenCalledTimes(1);
      expect(first.runtime.prompt).toHaveBeenCalledTimes(2);
      expect(first.runtime.prompt.mock.calls.map(([request]) => request.sessionId)).toEqual([
        "cursor-session-1",
        "cursor-session-1",
      ]);
      expect(first.runtime.prompt.mock.calls.map(([request]) => JSON.stringify(request.prompt))).toEqual([
        expect.stringContaining("first prompt"),
        expect.stringContaining("second prompt"),
      ]);
      expect(first.runtime.close).not.toHaveBeenCalled();
      expect(host.processes.terminateTree).not.toHaveBeenCalled();

      await provider.sendTurn(turn("fresh prompt", "execution-3"));

      expect(start).toHaveBeenCalledTimes(2);
      expect(second.connection.newSession).toHaveBeenCalledTimes(1);
      expect(host.processes.terminateTree).toHaveBeenCalledExactlyOnceWith(101);
    } finally {
      start.mockRestore();
      await (provider as unknown as { runtime: { shutdown(): Promise<void> } }).runtime.shutdown();
    }
  });

  it("reuses an unchanged Cursor process configuration and replaces it when the CLI changes", async () => {
    const host = createHost();
    const settings = getDefaultSettings();
    const first = createFakeRuntime("cursor-session-1", 101);
    const second = createFakeRuntime("cursor-session-2", 202);
    const runtimes = [first.runtime, second.runtime];
    const start = vi.spyOn(AcpSessionRuntime, "start").mockImplementation(async () => {
      const runtime = runtimes.shift();
      if (!runtime) throw new Error("Unexpected Cursor ACP spawn");
      return runtime;
    });
    const provider = new CursorProvider(host, {
      settings: { get: () => settings },
      skills: { list: () => [] },
    }, 60_000);

    try {
      await provider.sendTurn(turn("first prompt", "execution-1"));
      await provider.sendTurn(turn("second prompt", "execution-2", "cursor-session-1"));

      expect(start).toHaveBeenCalledTimes(1);
      expect(host.processes.terminateTree).not.toHaveBeenCalled();

      settings.provider.cli.cursor = "alternate-cursor-agent";
      await provider.sendTurn(turn("third prompt", "execution-3", "cursor-session-1"));

      expect(start).toHaveBeenCalledTimes(2);
      expect(host.processes.terminateTree).toHaveBeenCalledExactlyOnceWith(101);
      expect(second.runtime.prompt).toHaveBeenCalledOnce();
    } finally {
      start.mockRestore();
      await (provider as unknown as { runtime: { shutdown(): Promise<void> } }).runtime.shutdown();
    }
  });

  it("publishes a safe recovery error and leaves the saved Cursor identity untouched", async () => {
    const host = createHost();
    const failed = createFakeRuntime("replacement", 303);
    vi.mocked(failed.runtime.openSession).mockRejectedValue(new SessionRecoveryFailedError());
    const start = vi.spyOn(AcpSessionRuntime, "start").mockResolvedValue(failed.runtime);
    const provider = new CursorProvider(host, {
      settings: { get: () => getDefaultSettings() },
      skills: { list: () => [] },
    }, 60_000);

    try {
      await provider.sendTurn(turn("continue", "execution-failed", "saved-cursor-session"));

      const events = submittedRuntimeEvents(host);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "error",
          error: "SessionRecoveryFailed: Cursor could not recover the saved session. Retry starts a new Cursor session.",
        }),
        expect.objectContaining({ type: "ended", turnExecutionId: "execution-failed" }),
      ]));
      expect(failed.connection.newSession).not.toHaveBeenCalled();
    } finally {
      start.mockRestore();
      await (provider as unknown as { runtime: { shutdown(): Promise<void> } }).runtime.shutdown();
    }
  });

  it("retries a transient prompt on a replacement ACP connection and rejects late updates from the failed connection", async () => {
    const host = createHost();
    const first = createFakeRuntime("cursor-session-1", 101);
    const second = createFakeRuntime("cursor-session-2", 202);
    const runtimes = [first.runtime, second.runtime];
    const start = vi.spyOn(AcpSessionRuntime, "start").mockImplementation(async () => {
      const runtime = runtimes.shift();
      if (!runtime) throw new Error("Unexpected Cursor ACP spawn");
      return runtime;
    });
    const provider = new CursorProvider(host, {
      settings: { get: () => getDefaultSettings() },
      skills: { list: () => [] },
    }, 60_000);
    const retryResponse = deferred<{ stopReason: "end_turn"; usage: { inputTokens: number; outputTokens: number } }>();
    let failedEntry: CursorSessionState | undefined;
    vi.mocked(first.runtime.prompt).mockImplementation(async () => {
      failedEntry = (provider as unknown as {
        runtime: { get(sessionId: string): CursorSessionState | undefined };
      }).runtime.get("mcode-thread-1");
      throw new Error("[canceled] http/2 stream closed with error code CANCEL (0x8)");
    });
    vi.mocked(second.runtime.prompt).mockImplementation(async () => await retryResponse.promise);

    try {
      const sending = provider.sendTurn(turn("retry prompt", "execution-retry"));
      await vi.waitFor(() => expect(second.runtime.prompt).toHaveBeenCalledOnce());
      const bridge = (provider as unknown as {
        getAcpClientBridge(): {
          deliverSessionUpdate(entry: CursorSessionState, update: SessionNotification): Promise<void>;
        };
      }).getAcpClientBridge();
      const replacement = (provider as unknown as {
        runtime: { get(sessionId: string): CursorSessionState | undefined };
      }).runtime.get("mcode-thread-1");

      expect(failedEntry).toBeDefined();
      expect(failedEntry?.activeTurnState).toBeNull();
      expect(replacement).toBeDefined();
      expect(replacement).not.toBe(failedEntry);
      expect(second.runtime.openSession).toHaveBeenCalledWith(expect.objectContaining({
        resumeFrom: "cursor-session-1",
      }));
      expect(second.runtime.prompt).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "cursor-session-1",
      }));
      expect(first.connection.newSession).toHaveBeenCalledOnce();
      expect(second.connection.newSession).not.toHaveBeenCalled();
      expect(host.processes.terminateTree).toHaveBeenCalledExactlyOnceWith(101);

      await bridge.deliverSessionUpdate(failedEntry!, {
        sessionId: "cursor-session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "late failed text" },
        },
      } as SessionNotification);
      await bridge.deliverSessionUpdate(failedEntry!, {
        sessionId: "cursor-session-1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "late-failed-tool",
          title: "Read File",
          kind: "read",
          rawInput: { path: "late.txt" },
        },
      } as SessionNotification);
      await bridge.deliverSessionUpdate(replacement!, {
        sessionId: "cursor-session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "live retry response" },
        },
      } as SessionNotification);
      retryResponse.resolve({ stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } });
      await sending;

      const events = submittedRuntimeEvents(host);
      expect(events).toContainEqual(expect.objectContaining({
        type: "message",
        content: "live retry response",
        turnExecutionId: "execution-retry",
      }));
      expect(events).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ delta: "late failed text" }),
        expect.objectContaining({ toolCallId: "late-failed-tool" }),
        expect.objectContaining({
          type: "message",
          content: expect.stringContaining("late failed text"),
        }),
      ]));
    } finally {
      start.mockRestore();
      await (provider as unknown as { runtime: { shutdown(): Promise<void> } }).runtime.shutdown();
    }
  });

  it("does not create a replacement after a transient first-turn failure without a saved logical session", async () => {
    const host = createHost();
    const first = createFakeRuntime("cursor-session-1", 101);
    const start = vi.spyOn(AcpSessionRuntime, "start").mockResolvedValue(first.runtime);
    const provider = new CursorProvider(host, {
      settings: { get: () => getDefaultSettings() },
      skills: { list: () => [] },
    }, 60_000);
    vi.mocked(first.runtime.prompt).mockImplementation(async () => {
      (provider as unknown as { sdkSessionIds: Map<string, string> }).sdkSessionIds.delete(
        "mcode-thread-1",
      );
      throw new Error("[canceled] http/2 stream closed with error code CANCEL (0x8)");
    });

    try {
      await provider.sendTurn(turn("first prompt", "execution-first"));

      expect(start).toHaveBeenCalledOnce();
      expect(first.connection.newSession).toHaveBeenCalledOnce();
      expect(host.processes.terminateTree).toHaveBeenCalledExactlyOnceWith(101);
      expect(submittedRuntimeEvents(host)).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "error", turnExecutionId: "execution-first" }),
        expect.objectContaining({ type: "ended", turnExecutionId: "execution-first" }),
      ]));
    } finally {
      start.mockRestore();
      await (provider as unknown as { runtime: { shutdown(): Promise<void> } }).runtime.shutdown();
    }
  });
});
