import { describe, expect, it } from "vitest";
import { resolveActiveTerminalId } from "../resolveActiveTerminalId";

describe("resolveActiveTerminalId", () => {
  const terminals = {
    "thread-a": [
      { id: "pty-1", threadId: "thread-a", label: "powershell" },
      { id: "pty-2", threadId: "thread-a", label: "bash" },
    ],
  };

  it("returns null when thread has no terminals", () => {
    expect(resolveActiveTerminalId("thread-b", null, terminals)).toBeNull();
  });

  it("returns stored id when it matches a terminal on the thread", () => {
    expect(resolveActiveTerminalId("thread-a", "pty-2", terminals)).toBe("pty-2");
  });

  it("falls back to first terminal when stored id is null", () => {
    expect(resolveActiveTerminalId("thread-a", null, terminals)).toBe("pty-1");
  });

  it("falls back to first terminal when stored id is stale", () => {
    expect(resolveActiveTerminalId("thread-a", "pty-missing", terminals)).toBe(
      "pty-1",
    );
  });
});
