import { describe, expect, it } from "vitest";
import {
  resolvePtyHostExecutable,
  resolvePtyHostEntryPath,
  spawnPtyHostChild,
} from "../pty-host-child.js";

describe("PTY host production bundle path", () => {
  it("resolves pty-host.cjs beside server.cjs", () => {
    expect(resolvePtyHostEntryPath("C:/app/dist/server/server.cjs", {})).toMatch(/C:[\\/]app[\\/]dist[\\/]server[\\/]pty-host\.cjs$/);
  });

  it("resolves the unpacked PTY host when Bun runs from a compiled executable", () => {
    expect(resolvePtyHostEntryPath("C:/app/bin/mcode-bun.exe", {
      MCODE_PACKAGED_RESOURCES_ROOT: "C:/app/resources",
    })).toMatch(/C:[\\/]app[\\/]resources[\\/]app\.asar\.unpacked[\\/]dist[\\/]server[\\/]pty-host\.cjs$/);
  });

  it("requires a launcher-selected Electron executable", () => {
    expect(() => resolvePtyHostExecutable({})).toThrow(Error);
    expect(resolvePtyHostExecutable({ MCODE_PTY_HOST_EXECUTABLE: "C:/app/mcode-server.exe" }))
      .toBe("C:/app/mcode-server.exe");
  });

  it("rejects an absent executable instead of falling back to the server runtime", () => {
    expect(() => spawnPtyHostChild({
      platform: process.platform,
      architecture: process.arch,
      entryPath: "C:/app/dist/server/pty-host.cjs",
      executablePath: "",
      env: {},
    })).toThrow(Error);
  });
});
