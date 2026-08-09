import { describe, expect, it, vi } from "vitest";
import { TerminalClientSelector } from "./terminal-client-selector";

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
});
