import { describe, expect, it, vi } from "vitest";
import { TerminalClientSelector } from "../terminal-client-selector";

describe("TerminalClientSelector", () => {
  it("routes legacy lifecycle calls through the frozen version 0 RPC names", async () => {
    const rpc = vi.fn(async (method: string) => {
      if (method === "terminal.create") return { ptyId: "pty-1", shell: "pwsh" };
      if (method === "terminal.reattach") return { mode: "delta" };
      return undefined;
    });
    const selector = new TerminalClientSelector(rpc as never);
    const client = selector.select({
      contractVersion: 0,
      backend: "legacy",
      publicFrameVersion: 0,
      recovery: { replay: true, checkpoint: true, gap: true },
    });

    await expect(client.create("thread-1")).resolves.toEqual({
      ptyId: "pty-1",
      shell: "pwsh",
    });
    await expect(client.reattach("pty-1", 7)).resolves.toEqual({ mode: "delta" });
    expect(rpc).toHaveBeenNthCalledWith(1, "terminal.create", { threadId: "thread-1" });
    expect(rpc).toHaveBeenNthCalledWith(2, "terminal.reattach", {
      ptyId: "pty-1",
      lastSeq: 7,
      cold: undefined,
    });
    expect(selector.getSelected()).toBe(client);
  });

  it("fails before server capabilities select a client", () => {
    const selector = new TerminalClientSelector(vi.fn() as never);
    expect(() => selector.getSelected()).toThrow("Terminal client is not selected");
  });

  it("selects the modern adapter and sends v1 input frames", async () => {
    const rpc = vi.fn(async (method: string) => {
      if (method === "terminal.session.create") {
        return {
          sessionId: "00000000-0000-4000-8000-000000000001",
          launch: { resolvedProfile: { executable: "pwsh" } },
        };
      }
      return [];
    });
    const sendFrame = vi.fn();
    const selector = new TerminalClientSelector(rpc as never, sendFrame, async (scopeId) => ({
      kind: "thread",
      workspaceId: "00000000-0000-4000-8000-000000000003",
      threadId: scopeId,
    }));
    const client = selector.select({
      contractVersion: 1,
      backend: "modern",
      selectedAt: "2026-08-12T10:00:00.000Z",
      publicFrameVersion: 1,
      recovery: { replay: true, checkpoint: true, gap: true },
      host: { state: "healthy", generation: "7" },
      sessionLimit: 4,
    });

    await expect(client.create(
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000004",
    )).resolves.toEqual({
      ptyId: "00000000-0000-4000-8000-000000000001",
      shell: "pwsh",
    });
    expect(rpc).toHaveBeenCalledWith("terminal.session.create", {
      scope: {
        kind: "thread",
        threadId: "00000000-0000-4000-8000-000000000002",
        workspaceId: "00000000-0000-4000-8000-000000000003",
      },
      replacesSessionId: "00000000-0000-4000-8000-000000000004",
    });
    expect(selector.getSelected()).toBe(client);
  });
});
