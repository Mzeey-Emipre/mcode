import { describe, expect, it } from "vitest";
import { TerminalRpcError, toRpcError } from "./terminal-rpc-error";

describe("Terminal RPC errors", () => {
  it("retains only the closed recovery fields and hides backend detail", () => {
    const error = toRpcError({
      code: "REPLAY_GAP",
      retry: "REATTACH",
      correlationId: "corr-1",
      message: "SECRET /home/user/token",
    });

    expect(error).toBeInstanceOf(TerminalRpcError);
    expect(error).toMatchObject({ code: "REPLAY_GAP", retry: "REATTACH", correlationId: "corr-1" });
    expect(error.message).not.toContain("SECRET");
    expect(error.message).not.toContain("/home/user/token");
  });

  it("drops untrusted or out-of-bounds fields", () => {
    const error = new TerminalRpcError({
      code: "not-a-terminal-code",
      retry: "unsafe",
      correlationId: "x".repeat(65),
      message: "not exposed",
    });

    expect(error).toEqual(expect.any(Error));
    expect(error.code).toBeUndefined();
    expect(error.retry).toBeUndefined();
    expect(error.correlationId).toBeUndefined();
    expect(error.message).toBe("Terminal request failed");
  });
});
