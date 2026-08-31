import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as NodeFSPromises from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
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

const repoRoot = NodePath.resolve(import.meta.dirname, "../../../..");
const serverRoot = NodePath.join(repoRoot, "apps/server");

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
    const appOutDir = NodePath.resolve("/dist/win-unpacked");
    expect(
      resolvePackagedServerDir({
        appOutDir,
        electronPlatformName: "win32",
        productFilename: "Mcode",
      }),
    ).toBe(NodePath.join(appOutDir, "resources", "app.asar.unpacked", "dist", "server"));
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

describe("resolveCopilotSdkSources", () => {
  it("uses the SDK store package when the target package has no resolvable export", async () => {
    const fixtureRoot = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "copilot-sdk-store-"));
    const fixtureServerRoot = NodePath.join(fixtureRoot, "server");
    const packageRoot = NodePath.join(fixtureServerRoot, "node_modules", "@github");
    const sdkRoot = NodePath.join(packageRoot, "copilot-sdk");
    const targetRoot = NodePath.join(packageRoot, "copilot-darwin-x64");
    const copilotRoot = NodePath.join(packageRoot, "copilot");
    try {
      await NodeFSPromises.mkdir(NodePath.join(sdkRoot, "dist", "cjs"), { recursive: true });
      await NodeFSPromises.mkdir(targetRoot, { recursive: true });
      await NodeFSPromises.mkdir(copilotRoot, { recursive: true });
      await NodeFSPromises.writeFile(NodePath.join(fixtureServerRoot, "package.json"), "{}\n");
      await NodeFSPromises.writeFile(
        NodePath.join(sdkRoot, "package.json"),
        '{"main":"dist/cjs/index.js"}\n',
      );
      await NodeFSPromises.writeFile(NodePath.join(sdkRoot, "dist", "cjs", "index.js"), "");
      await NodeFSPromises.writeFile(NodePath.join(copilotRoot, "package.json"), "{}\n");
      await NodeFSPromises.writeFile(NodePath.join(targetRoot, "package.json"), '{"exports":{}}\n');
      await NodeFSPromises.writeFile(NodePath.join(targetRoot, "copilot"), "");

      expect(resolveCopilotSdkSources(fixtureServerRoot, "darwin", "x64")).toEqual({
        platformPkg: "@github/copilot-darwin-x64",
        copilotPackageDir: copilotRoot,
        platformPackageDir: targetRoot,
      });
    } finally {
      await NodeFSPromises.rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});

describe("copyClaudeSdkCliToDir", () => {
  /** @type {string | undefined} */
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "claude-sdk-copy-"));
  });

  afterEach(async () => {
    if (tmpDir) {
      await NodeFSPromises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("copies the CLI binary and package.json into dist/server/node_modules", async () => {
    const serverDir = NodePath.join(tmpDir, "resources", "app.asar.unpacked", "dist", "server");
    const platform = process.platform;
    const arch = process.arch;
    const { binDst } = copyClaudeSdkCliToDir({
      destServerDir: serverDir,
      serverPackageRoot: serverRoot,
      platform,
      arch,
    });
    const expected = expectedClaudeSdkCliPath(NodePath.join(serverDir, "server.cjs"), platform, arch);
    const found = findClaudeSdkCliPath(NodePath.join(serverDir, "server.cjs"), platform, arch);
    expect(found).toBe(binDst);
    if (platform === "linux") {
      expect(found).toBeTruthy();
    } else {
      expect(binDst).toBe(expected);
    }
    const binStat = await NodeFSPromises.stat(binDst);
    expect(binStat.size).toBeGreaterThan(1_000_000);
    await NodeFSPromises.access(NodePath.join(NodePath.dirname(binDst), "package.json"), NodeFS.constants.R_OK);
  });
});

describe("copyClaudeSdkCliNextTo", () => {
  /** @type {string | undefined} */
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "claude-sdk-nextto-"));
  });

  afterEach(async () => {
    if (tmpDir) {
      await NodeFSPromises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("skipped re-copying when the destination already matches the source size", async () => {
    const serverCjs = NodePath.join(tmpDir, "server.cjs");
    copyClaudeSdkCliNextTo(serverCjs, serverRoot);
    const platform = process.platform;
    const arch = process.arch;
    const binDst = findClaudeSdkCliPath(serverCjs, platform, arch);
    expect(binDst).toBeTruthy();
    const firstMtime = (await NodeFSPromises.stat(binDst)).mtimeMs;
    copyClaudeSdkCliNextTo(serverCjs, serverRoot);
    const secondMtime = (await NodeFSPromises.stat(binDst)).mtimeMs;
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
    const tmpDir = await NodeFSPromises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "copilot-sdk-stage-"));
    try {
      const serverCjs = NodePath.join(tmpDir, "server.cjs");
      const dev = copyCopilotSdkNextTo(serverCjs, serverRoot);
      // Bun may list unavailable optional native links while traversing this package.
      // Reaching these assertions proves they did not abort staging.
      expect(findCopilotSdkPath(serverCjs, process.platform, process.arch)).toBe(dev.copilotDst + NodePath.sep + "index.js");
      expect((await NodeFSPromises.lstat(dev.copilotDst)).isSymbolicLink()).toBe(false);
      expect((await NodeFSPromises.lstat(dev.platformDst)).isSymbolicLink()).toBe(false);
      await NodeFSPromises.access(NodePath.join(dev.copilotDst, "package.json"), NodeFS.constants.R_OK);
      await NodeFSPromises.access(NodePath.join(dev.platformDst, "package.json"), NodeFS.constants.R_OK);
      await NodeFSPromises.access(
        NodePath.join(dev.platformDst, process.platform === "win32" ? "copilot.exe" : "copilot"),
        NodeFS.constants.R_OK,
      );

      const stagedIndex = NodePath.join(dev.copilotDst, "index.js");
      const originalIndex = await NodeFSPromises.readFile(stagedIndex);
      const preservedMtime = new Date("2001-01-01T00:00:00.000Z");
      await NodeFSPromises.utimes(stagedIndex, preservedMtime, preservedMtime);
      const preservedMtimeMs = (await NodeFSPromises.stat(stagedIndex)).mtimeMs;
      await new Promise((resolve) => setTimeout(resolve, 20));
      copyCopilotSdkNextTo(serverCjs, serverRoot);
      expect((await NodeFSPromises.stat(stagedIndex)).mtimeMs).toBe(preservedMtimeMs);

      const changedIndex = Buffer.from(originalIndex);
      changedIndex[0] ^= 1;
      await NodeFSPromises.writeFile(stagedIndex, changedIndex);
      await NodeFSPromises.utimes(stagedIndex, preservedMtime, preservedMtime);
      copyCopilotSdkNextTo(serverCjs, serverRoot);
      expect(await NodeFSPromises.readFile(stagedIndex)).toEqual(originalIndex);

      const packagedDir = NodePath.join(tmpDir, "resources", "app.asar.unpacked", "dist", "server");
      const packaged = copyCopilotSdkToDir({
        destServerDir: packagedDir,
        serverPackageRoot: serverRoot,
        platform: process.platform,
        arch: process.arch,
      });
      expect(packaged.copilotDst).toContain(NodePath.join("node_modules", "@github", "copilot"));
      expect(findCopilotSdkPath(NodePath.join(packagedDir, "server.cjs"), process.platform, process.arch)).toBe(
        NodePath.join(packaged.copilotDst, "index.js"),
      );
      expect((await NodeFSPromises.lstat(packaged.copilotDst)).isSymbolicLink()).toBe(false);
      expect((await NodeFSPromises.lstat(packaged.platformDst)).isSymbolicLink()).toBe(false);
      await NodeFSPromises.access(NodePath.join(packaged.platformDst, process.platform === "win32" ? "copilot.exe" : "copilot"), NodeFS.constants.R_OK);
    } finally {
      await NodeFSPromises.rm(tmpDir, { recursive: true, force: true });
    }
  }, 20_000);
});
