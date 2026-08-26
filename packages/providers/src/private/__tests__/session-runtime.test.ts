import { describe, expect, it, vi } from "vitest";
import { SessionRuntime, type ProtocolAdapter } from "../session-runtime.js";

describe("SessionRuntime", () => {
  it("uses the server process port for spawned session ownership and cleanup", async () => {
    const state = { id: "state" };
    const adapter: ProtocolAdapter<typeof state> = {
      spawn: vi.fn(async () => ({ state, pids: [401] })),
      isBusy: () => false,
      interrupt: vi.fn(),
      close: vi.fn(),
      isStale: () => false,
    };
    const attach = vi.fn();
    const terminateTree = vi.fn(async () => undefined);
    const runtime = new SessionRuntime(adapter, {
      jobObject: { isWindowsJob: false, assign: () => false, setDescription: () => undefined },
      processes: { attach, terminateTree },
      envService: { getEnv: () => ({}) },
    });

    await runtime.acquire({
      sessionId: "mcode-session",
      threadId: "thread",
      cwd: ".",
      permissionMode: "default",
    });
    await runtime.stop("mcode-session");

    expect(attach).toHaveBeenCalledExactlyOnceWith(401, "mcode session mcode-session");
    expect(adapter.interrupt).toHaveBeenCalledExactlyOnceWith(state);
    expect(adapter.close).toHaveBeenCalledExactlyOnceWith(state);
    expect(terminateTree).toHaveBeenCalledExactlyOnceWith(401);
  });
});
