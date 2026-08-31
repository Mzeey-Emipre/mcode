import { describe, it, expect, vi, beforeEach } from "vitest";
import * as NodePath from "node:path";
import * as NodeFS from "node:fs";
import { resolveServerBinary } from "../binary-resolver.js";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, existsSync: vi.fn() };
});

describe("resolveServerBinary", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns process.execPath in dev mode regardless of platform", () => {
    const result = resolveServerBinary({
      isPackaged: false,
      execPath: "/usr/bin/electron",
      resourcesPath: "/tmp/whatever",
      platform: "win32",
    });
    expect(result).toBe("/usr/bin/electron");
  });

  it("returns renamed binary on Windows when present", () => {
    vi.mocked(NodeFS.existsSync).mockReturnValue(true);
    const result = resolveServerBinary({
      isPackaged: true,
      execPath: "C:\\app\\Mcode.exe",
      resourcesPath: "C:\\app\\resources",
      platform: "win32",
    });
    expect(result).toBe(NodePath.join("C:\\app\\resources", "bin", "mcode-server.exe"));
  });

  it("returns renamed binary on macOS when present", () => {
    vi.mocked(NodeFS.existsSync).mockReturnValue(true);
    const result = resolveServerBinary({
      isPackaged: true,
      execPath: "/Apps/MCode.app/Contents/MacOS/MCode",
      resourcesPath: "/Apps/MCode.app/Contents/Resources",
      platform: "darwin",
    });
    expect(result).toBe(NodePath.join("/Apps/MCode.app/Contents/Resources", "bin", "mcode-server"));
  });

  it("returns renamed binary on Linux when present", () => {
    vi.mocked(NodeFS.existsSync).mockReturnValue(true);
    const result = resolveServerBinary({
      isPackaged: true,
      execPath: "/opt/mcode/mcode",
      resourcesPath: "/opt/mcode/resources",
      platform: "linux",
    });
    expect(result).toBe(NodePath.join("/opt/mcode/resources", "bin", "mcode-server"));
  });

  it("falls back to execPath when renamed binary is missing", () => {
    vi.mocked(NodeFS.existsSync).mockReturnValue(false);
    const result = resolveServerBinary({
      isPackaged: true,
      execPath: "/Apps/MCode.app/Contents/MacOS/MCode",
      resourcesPath: "/Apps/MCode.app/Contents/Resources",
      platform: "darwin",
    });
    expect(result).toBe("/Apps/MCode.app/Contents/MacOS/MCode");
  });
});
