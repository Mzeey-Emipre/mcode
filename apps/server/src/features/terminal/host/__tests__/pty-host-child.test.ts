import { describe, expect, it } from "vitest";
import { resolvePtyHostEntryPath } from "../pty-host-child.js";

describe("PTY host production bundle path", () => {
  it("resolves pty-host.cjs beside server.cjs", () => {
    expect(resolvePtyHostEntryPath("C:/app/dist/server/server.cjs")).toMatch(/C:[\\/]app[\\/]dist[\\/]server[\\/]pty-host\.cjs$/);
  });
});
