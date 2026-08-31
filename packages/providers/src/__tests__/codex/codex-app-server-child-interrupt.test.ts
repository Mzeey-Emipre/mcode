import { describe, expect, it, vi } from "vitest";
import {
  CodexAppServer as NativeCodexAppServer,
  type CodexAppServerOptions,
} from "../../private/codex/codex-app-server.js";

class CodexAppServer extends NativeCodexAppServer {
  constructor(options: Omit<CodexAppServerOptions, "platform">) {
    super({ ...options, platform: process.platform });
  }
}

describe("CodexAppServer interrupt drains", () => {
  it("drains the matching main terminal notification after acknowledgement", async () => {
    const sendRequest = vi.fn().mockResolvedValue({});
    const server = new CodexAppServer({
      cliPath: "codex",
      workingDirectory: process.cwd(),
    });
    (server as unknown as { _threadId: string })._threadId = "native-main-thread";
    (server as unknown as { rpc: { sendRequest: typeof sendRequest } }).rpc = { sendRequest };

    let settled = false;
    const stopping = server.interruptTurnAndDrain("native-main-turn")
      .then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    server.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: "native-main-thread",
        turn: { id: "other-turn", status: "interrupted" },
      },
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    server.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: "other-main-thread",
        turn: { id: "native-main-turn", status: "interrupted" },
      },
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    server.emit("notification", {
      method: "turn/completed",
      params: {
        turn: { id: "native-main-turn", status: "interrupted" },
      },
    });
    await stopping;

    expect(sendRequest).toHaveBeenCalledWith(
      "turn/interrupt",
      { threadId: "native-main-thread", turnId: "native-main-turn" },
      5_000,
    );
  });

  it("rejects when main acknowledgement is not followed by its terminal notification", async () => {
    vi.useFakeTimers();
    try {
      const sendRequest = vi.fn().mockResolvedValue({});
      const server = new CodexAppServer({
        cliPath: "codex",
        workingDirectory: process.cwd(),
      });
      (server as unknown as { _threadId: string })._threadId = "native-main-thread";
      (server as unknown as { rpc: { sendRequest: typeof sendRequest } }).rpc = { sendRequest };

      const stopping = server.interruptTurnAndDrain("native-main-turn");
      const rejection = expect(stopping).rejects.toThrow(
        "Main interruption timed out waiting for terminal completion.",
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends the exact native thread and turn identifiers", async () => {
    const sendRequest = vi.fn().mockResolvedValue({});
    const server = new CodexAppServer({
      cliPath: "codex",
      workingDirectory: process.cwd(),
    });
    (server as unknown as { rpc: { sendRequest: typeof sendRequest } }).rpc = { sendRequest };
    const acknowledged = server.interruptChildTurn("native-child-thread", "native-child-turn");
    server.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: "native-child-thread",
        turn: { id: "native-child-turn", status: "interrupted" },
      },
    });

    await acknowledged;

    expect(sendRequest).toHaveBeenCalledOnce();
    expect(sendRequest).toHaveBeenCalledWith(
      "turn/interrupt",
      { threadId: "native-child-thread", turnId: "native-child-turn" },
      5_000,
    );
  });

  it("surfaces a provider acknowledgement failure", async () => {
    const sendRequest = vi.fn().mockRejectedValue(new Error("native turn missing"));
    const server = new CodexAppServer({
      cliPath: "codex",
      workingDirectory: process.cwd(),
    });
    (server as unknown as { rpc: { sendRequest: typeof sendRequest } }).rpc = { sendRequest };

    await expect(server.interruptChildTurn("native-child-thread", "native-child-turn"))
      .rejects.toThrow("native turn missing");
  });

  it("waits for the matching child terminal notification after acknowledgement", async () => {
    let acknowledge!: (result: Record<string, never>) => void;
    const sendRequest = vi.fn().mockReturnValue(new Promise<Record<string, never>>((resolve) => {
      acknowledge = resolve;
    }));
    const server = new CodexAppServer({
      cliPath: "codex",
      workingDirectory: process.cwd(),
    });
    (server as unknown as { rpc: { sendRequest: typeof sendRequest } }).rpc = { sendRequest };

    let settled = false;
    const stopping = server.interruptChildTurn("native-child-thread", "native-child-turn")
      .then(() => { settled = true; });
    acknowledge({});
    await Promise.resolve();
    expect(settled).toBe(false);

    server.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: "native-child-thread",
        turn: { id: "native-child-turn", status: "interrupted" },
      },
    });
    await stopping;
    expect(settled).toBe(true);
  });

  it("rejects when acknowledgement is not followed by the matching terminal notification", async () => {
    vi.useFakeTimers();
    try {
      const sendRequest = vi.fn().mockResolvedValue({});
      const server = new CodexAppServer({
        cliPath: "codex",
        workingDirectory: process.cwd(),
      });
      (server as unknown as { rpc: { sendRequest: typeof sendRequest } }).rpc = { sendRequest };

      const stopping = server.interruptChildTurn("native-child-thread", "native-child-turn");
      const rejection = expect(stopping).rejects.toThrow(
        "Child interruption timed out waiting for terminal completion.",
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});
