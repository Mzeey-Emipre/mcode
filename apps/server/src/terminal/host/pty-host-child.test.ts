import { describe, expect, it, vi } from "vitest";
import {
  forwardPtyHostStderr,
  PTY_HOST_STDERR_MAX_BYTES,
} from "./pty-host-diagnostics.js";
import { resolvePtyHostEntryPath } from "./pty-host-child.js";

describe("PTY host production bundle path", () => {
  it("resolves pty-host.cjs beside server.cjs", () => {
    expect(resolvePtyHostEntryPath("C:/app/dist/server/server.cjs")).toMatch(/C:[\\/]app[\\/]dist[\\/]server[\\/]pty-host\.cjs$/);
  });

  it("bounds each release-test stderr chunk before forwarding", () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      forwardPtyHostStderr("x".repeat(PTY_HOST_STDERR_MAX_BYTES + 128));
      const forwarded = String(write.mock.calls[0]?.[0]);
      expect(forwarded.startsWith("[pty-host.stderr] ")).toBe(true);
      expect(Buffer.byteLength(forwarded.slice("[pty-host.stderr] ".length))).toBeLessThanOrEqual(
        PTY_HOST_STDERR_MAX_BYTES,
      );
    } finally {
      write.mockRestore();
    }
  });
});
