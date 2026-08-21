import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, stat, lstat, access, readFile, writeFile, utimes } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  claudeSdkPlatformPackageCandidates,
  claudeSdkPlatformParts,
  copyClaudeSdkCliNextTo,
  copyClaudeSdkCliToDir,
  electronArchToNpm,
  electronPlatformToNpm,
  expectedClaudeSdkCliPath,
  findClaudeSdkCliPath,
  resolveClaudeSdkCliSources,
  resolvePackagedServerDir,
  copilotSdkPlatformPackageName,
  copyCopilotSdkNextTo,
  copyCopilotSdkToDir,
  findCopilotSdkPath,
  resolveCopilotSdkSources,
} from "../../../../scripts/build-server-dev-bundle.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const serverRoot = path.join(repoRoot, "apps/server");

describe("electronPlatformToNpm", () => {
  it("maps electron-builder platform names to npm values", () => {
    expect(electronPlatformToNpm("win32")).toBe("win32");
    expect(electronPlatformToNpm("darwin")).toBe("darwin");
    expect(electronPlatformToNpm("mas")).toBe("darwin");
    expect(electronPlatformToNpm("linux")).toBe("linux");
  });
});

describe("electronArchToNpm", () => {
  it("maps electron-builder Arch enum values to npm arch strings", () => {
    expect(electronArchToNpm(1)).toBe("x64");
    expect(electronArchToNpm(3)).toBe("arm64");
    expect(electronArchToNpm("x64")).toBe("x64");
    expect(electronArchToNpm("arm64")).toBe("arm64");
  });
});

describe("resolvePackagedServerDir", () => {
  it("resolves Windows and Linux paths under resources/", () => {
    // Resolve to a host-absolute appOutDir so the assertion holds on every OS:
    // a bare "C:/..." is absolute on Windows but relative on POSIX, which would
    // make resolve() prepend the cwd and diverge from join().
    const appOutDir = path.resolve("/dist/win-unpacked");
    expect(
      resolvePackagedServerDir({
        appOutDir,
        electronPlatformName: "win32",
        productFilename: "Mcode",
      }),
    ).toBe(path.join(appOutDir, "resources", "app.asar.unpacked", "dist", "server"));
  });

  it("resolves macOS paths under Contents/Resources/", () => {
    const result = resolvePackagedServerDir({
      appOutDir: "/dist/mac",
      electronPlatformName: "darwin",
      productFilename: "Mcode",
    });
    expect(result.replace(/\\/g, "/")).toMatch(
      /\/Mcode\.app\/Contents\/Resources\/app\.asar\.unpacked\/dist\/server$/,
    );
  });
});

describe("claudeSdkPlatformParts", () => {
  it("uses claude.exe on win32 and claude elsewhere", () => {
    expect(claudeSdkPlatformParts("win32", "x64")).toEqual({
      platformPkg: "@anthropic-ai/claude-agent-sdk-win32-x64",
      binName: "claude.exe",
    });
    expect(claudeSdkPlatformParts("darwin", "arm64")).toEqual({
      platformPkg: "@anthropic-ai/claude-agent-sdk-darwin-arm64",
      binName: "claude",
    });
  });
});

describe("claudeSdkPlatformPackageCandidates", () => {
  it("tries linux musl before glibc package names", () => {
    expect(claudeSdkPlatformPackageCandidates("linux", "x64")).toEqual([
      "@anthropic-ai/claude-agent-sdk-linux-x64-musl",
      "@anthropic-ai/claude-agent-sdk-linux-x64",
    ]);
  });
});

describe("resolveClaudeSdkCliSources", () => {
  it("resolves the installed platform package on the build host", () => {
    const platform = process.platform;
    const arch = process.arch;
    const sources = resolveClaudeSdkCliSources(serverRoot, platform, arch);
    expect(sources.binSrc).toMatch(/claude(\.exe)?$/);
    expect(sources.platformPkg).toMatch(/@anthropic-ai\/claude-agent-sdk-/);
  });

  it("throws a bun install hint when the platform package is missing", () => {
    expect(() =>
      resolveClaudeSdkCliSources(serverRoot, "linux", "s390x"),
    ).toThrow(
      "not installed - run 'bun install' or node apps/desktop/scripts/desktop-packaging/target-package/target-package.mjs",
    );
  });
});

describe("copyClaudeSdkCliToDir", () => {
  /** @type {string | undefined} */
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "claude-sdk-copy-"));
  });

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("copies the CLI binary and package.json into dist/server/node_modules", async () => {
    const serverDir = path.join(tmpDir, "resources", "app.asar.unpacked", "dist", "server");
    const platform = process.platform;
    const arch = process.arch;
    const { binDst } = copyClaudeSdkCliToDir({
      destServerDir: serverDir,
      serverPackageRoot: serverRoot,
      platform,
      arch,
    });
    const expected = expectedClaudeSdkCliPath(path.join(serverDir, "server.cjs"), platform, arch);
    const found = findClaudeSdkCliPath(path.join(serverDir, "server.cjs"), platform, arch);
    expect(found).toBe(binDst);
    if (platform === "linux") {
      expect(found).toBeTruthy();
    } else {
      expect(binDst).toBe(expected);
    }
    const binStat = await stat(binDst);
    expect(binStat.size).toBeGreaterThan(1_000_000);
    await access(path.join(path.dirname(binDst), "package.json"), constants.R_OK);
  });
});

describe("copyClaudeSdkCliNextTo", () => {
  /** @type {string | undefined} */
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "claude-sdk-nextto-"));
  });

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("skipped re-copying when the destination already matches the source size", async () => {
    const serverCjs = path.join(tmpDir, "server.cjs");
    copyClaudeSdkCliNextTo(serverCjs, serverRoot);
    const platform = process.platform;
    const arch = process.arch;
    const binDst = findClaudeSdkCliPath(serverCjs, platform, arch);
    expect(binDst).toBeTruthy();
    const firstMtime = (await stat(binDst)).mtimeMs;
    copyClaudeSdkCliNextTo(serverCjs, serverRoot);
    const secondMtime = (await stat(binDst)).mtimeMs;
    expect(secondMtime).toBe(firstMtime);
  });
});

describe("Copilot SDK staging", () => {
  it("resolves the SDK package and target platform dependency from the SDK graph", () => {
    const sources = resolveCopilotSdkSources(serverRoot, process.platform, process.arch);
    expect(sources.copilotPackageDir).toMatch(/[\\/]@github[\\/]copilot$/);
    expect(sources.platformPackageDir.endsWith(`copilot-${process.platform}-${process.arch}`)).toBe(true);
    expect(sources.platformPkg).toBe(copilotSdkPlatformPackageName(process.platform, process.arch));
  });

  it("stages both complete package trees for dev and packaged destinations", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "copilot-sdk-stage-"));
    try {
      const serverCjs = path.join(tmpDir, "server.cjs");
      const dev = copyCopilotSdkNextTo(serverCjs, serverRoot);
      // Bun may list unavailable optional native links while traversing this package.
      // Reaching these assertions proves they did not abort staging.
      expect(findCopilotSdkPath(serverCjs, process.platform, process.arch)).toBe(dev.copilotDst + path.sep + "index.js");
      expect((await lstat(dev.copilotDst)).isSymbolicLink()).toBe(false);
      expect((await lstat(dev.platformDst)).isSymbolicLink()).toBe(false);
      await access(path.join(dev.copilotDst, "package.json"), constants.R_OK);
      await access(path.join(dev.platformDst, "package.json"), constants.R_OK);
      await access(
        path.join(dev.platformDst, process.platform === "win32" ? "copilot.exe" : "copilot"),
        constants.R_OK,
      );

      const stagedIndex = path.join(dev.copilotDst, "index.js");
      const originalIndex = await readFile(stagedIndex);
      const preservedMtime = new Date("2001-01-01T00:00:00.000Z");
      await utimes(stagedIndex, preservedMtime, preservedMtime);
      const preservedMtimeMs = (await stat(stagedIndex)).mtimeMs;
      await new Promise((resolve) => setTimeout(resolve, 20));
      copyCopilotSdkNextTo(serverCjs, serverRoot);
      expect((await stat(stagedIndex)).mtimeMs).toBe(preservedMtimeMs);

      const changedIndex = Buffer.from(originalIndex);
      changedIndex[0] ^= 1;
      await writeFile(stagedIndex, changedIndex);
      await utimes(stagedIndex, preservedMtime, preservedMtime);
      copyCopilotSdkNextTo(serverCjs, serverRoot);
      expect(await readFile(stagedIndex)).toEqual(originalIndex);

      const packagedDir = path.join(tmpDir, "resources", "app.asar.unpacked", "dist", "server");
      const packaged = copyCopilotSdkToDir({
        destServerDir: packagedDir,
        serverPackageRoot: serverRoot,
        platform: process.platform,
        arch: process.arch,
      });
      expect(packaged.copilotDst).toContain(path.join("node_modules", "@github", "copilot"));
      expect(findCopilotSdkPath(path.join(packagedDir, "server.cjs"), process.platform, process.arch)).toBe(
        path.join(packaged.copilotDst, "index.js"),
      );
      expect((await lstat(packaged.copilotDst)).isSymbolicLink()).toBe(false);
      expect((await lstat(packaged.platformDst)).isSymbolicLink()).toBe(false);
      await access(path.join(packaged.platformDst, process.platform === "win32" ? "copilot.exe" : "copilot"), constants.R_OK);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }, 20_000);
});
