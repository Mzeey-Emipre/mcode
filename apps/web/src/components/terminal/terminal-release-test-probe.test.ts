import { describe, expect, it } from "vitest";
import {
  readTerminalReleaseTestSnapshot,
  recordTerminalReleaseTestRuntime,
} from "./terminal-release-test-probe";

describe("terminal release-test probe", () => {
  it("reports active dimensions, cursor, wrapping, and normalized lines", () => {
    const snapshot = readTerminalReleaseTestSnapshot({
      cols: 12,
      rows: 3,
      buffer: {
        active: {
          cursorX: 4,
          cursorY: 1,
          length: 2,
          getLine: (index: number) =>
            index === 0
              ? { isWrapped: false, translateToString: () => "alpha   " }
              : index === 1
                ? { isWrapped: true, translateToString: () => "beta\r" }
                : undefined,
        },
      },
    } as never);

    expect(snapshot).toEqual({
      cols: 12,
      rows: 3,
      cursor: { x: 4, y: 1 },
      lines: [
        { text: "alpha   ", wrapped: false },
        { text: "beta", wrapped: true },
      ],
      normalizedLines: ["alpha", "beta"],
    });
  });

  it("retains the guarded PTY host PID observation", () => {
    const snapshot = recordTerminalReleaseTestRuntime({
      capabilities: {
        contractVersion: 1,
        backend: "modern",
        releaseTest: { hostPid: 42 },
        host: { state: "healthy", generation: "1" },
      },
      sessions: [],
    } as never);

    expect(snapshot.capabilities.releaseTest).toEqual({ hostPid: 42 });
  });
});
