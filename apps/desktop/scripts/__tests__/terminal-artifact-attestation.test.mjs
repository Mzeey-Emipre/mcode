import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  attestPackagedTerminalArtifacts,
  retainTargetTerminalNativeArtifacts,
} from "../terminal-artifact-attestation.mjs";

function writeFile(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, value);
}

function peBinary(machine) {
  const bytes = Buffer.alloc(128);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(64, 0x3c);
  bytes.write("PE\0\0", 64, "binary");
  bytes.writeUInt16LE(machine, 68);
  return bytes;
}

describe("attestPackagedTerminalArtifacts", () => {
  let resourcesRoot;
  let nodePtyRoot;
  let koffiRoot;
  let runtimePath;
  let nodePtyBinding;
  let koffiBinding;

  beforeEach(() => {
    resourcesRoot = mkdtempSync(path.join(tmpdir(), "mcode-terminal-package-"));
    nodePtyRoot = path.join(
      resourcesRoot,
      "app.asar.unpacked/node_modules/node-pty",
    );
    koffiRoot = path.join(
      resourcesRoot,
      "app.asar.unpacked/node_modules/koffi",
    );
    runtimePath = path.join(resourcesRoot, "bin/mcode-server.exe");
    nodePtyBinding = path.join(nodePtyRoot, "build/Release/conpty.node");
    koffiBinding = path.join(koffiRoot, "build/koffi/win32_x64/koffi.node");

    writeFile(runtimePath, "runtime");
    writeFile(
      path.join(resourcesRoot, "app.asar.unpacked/dist/server/pty-host.cjs"),
      "require('node-pty'); require('koffi');",
    );
    writeFile(
      path.join(nodePtyRoot, "package.json"),
      '{"name":"node-pty","version":"1.0.0"}',
    );
    writeFile(
      path.join(koffiRoot, "package.json"),
      '{"name":"koffi","version":"2.16.1"}',
    );
    writeFile(nodePtyBinding, peBinary(0x8664));
    writeFile(koffiBinding, peBinary(0x8664));
    writeFile(
      path.join(nodePtyRoot, "build/Release/conpty/conpty.dll"),
      peBinary(0x8664),
    );
    writeFile(
      path.join(nodePtyRoot, "build/Release/conpty/OpenConsole.exe"),
      peBinary(0x8664),
    );
  });

  afterEach(() => {
    rmSync(resourcesRoot, { recursive: true, force: true });
  });

  it("attests the packaged host and exact native modules loaded by the target runtime", () => {
    const report = attestPackagedTerminalArtifacts({
      resourcesRoot,
      runtimePath,
      targetPlatform: "win32",
      targetArch: "x64",
      runLoadProbe: () => ({
        platform: "win32",
        arch: "x64",
        modulesAbi: "127",
        hostReady: true,
        nativeModules: [
          { packageName: "node-pty", path: nodePtyBinding },
          { packageName: "koffi", path: koffiBinding },
        ],
      }),
    });

    expect(report).toMatchObject({
      contractVersion: 1,
      target: { platform: "win32", arch: "x64", modulesAbi: "127" },
      dependencies: { "node-pty": "1.0.0", koffi: "2.16.1" },
    });
    expect(report.artifacts.map((artifact) => artifact.kind)).toEqual([
      "pty-host",
      "node-pty",
      "koffi",
      "conpty-runtime",
      "conpty-runtime",
    ]);
    expect(
      report.artifacts.every((artifact) =>
        /^[a-f0-9]{64}$/.test(artifact.sha256),
      ),
    ).toBe(true);
    expect(
      report.artifacts
        .filter((artifact) => artifact.kind !== "pty-host")
        .every(
          (artifact) =>
            artifact.architecture === "x64" &&
            artifact.modulesAbi === "127" &&
            artifact.origin.includes("@"),
        ),
    ).toBe(true);
    expect(report.compressedBytes).toBeGreaterThan(0);
    expect(report.packageFileCount).toBeGreaterThan(report.artifacts.length);
  });

  it("rejects duplicate or foreign native artifacts left in the target package", () => {
    writeFile(
      path.join(nodePtyRoot, "prebuilds/win32-arm64/conpty.node"),
      peBinary(0xaa64),
    );

    expect(() =>
      attestPackagedTerminalArtifacts({
        resourcesRoot,
        runtimePath,
        targetPlatform: "win32",
        targetArch: "x64",
        runLoadProbe: () => ({
          platform: "win32",
          arch: "x64",
          modulesAbi: "127",
          hostReady: true,
          nativeModules: [
            { packageName: "node-pty", path: nodePtyBinding },
            { packageName: "koffi", path: koffiBinding },
          ],
        }),
      }),
    ).toThrow("unexpected or duplicate");
  });

  it("retains only the target native runtime before attestation", () => {
    const foreignBinding = path.join(
      nodePtyRoot,
      "prebuilds/win32-arm64/conpty.node",
    );
    const foreignKoffi = path.join(
      koffiRoot,
      "build/koffi/darwin_x64/koffi.node",
    );
    writeFile(foreignBinding, peBinary(0xaa64));
    writeFile(foreignKoffi, peBinary(0x8664));

    retainTargetTerminalNativeArtifacts({
      resourcesRoot,
      targetPlatform: "win32",
      targetArch: "x64",
    });

    expect(existsSync(nodePtyBinding)).toBe(true);
    expect(existsSync(koffiBinding)).toBe(true);
    expect(existsSync(foreignBinding)).toBe(false);
    expect(existsSync(foreignKoffi)).toBe(false);
  });

  it("retains a valid target prebuild when a stale rebuilt binding is foreign", () => {
    const targetPrebuild = path.join(
      nodePtyRoot,
      "prebuilds/win32-x64/conpty.node",
    );
    writeFile(nodePtyBinding, peBinary(0xaa64));
    writeFile(targetPrebuild, peBinary(0x8664));
    writeFile(
      path.join(nodePtyRoot, "prebuilds/win32-x64/conpty/conpty.dll"),
      peBinary(0x8664),
    );
    writeFile(
      path.join(nodePtyRoot, "prebuilds/win32-x64/conpty/OpenConsole.exe"),
      peBinary(0x8664),
    );

    retainTargetTerminalNativeArtifacts({
      resourcesRoot,
      targetPlatform: "win32",
      targetArch: "x64",
    });

    expect(existsSync(nodePtyBinding)).toBe(false);
    expect(existsSync(targetPrebuild)).toBe(true);
  });

  it("removes node-gyp tool links before enforcing the package inventory", () => {
    const toolLink = path.join(
      nodePtyRoot,
      "build/node_gyp_bins/python3",
    );
    mkdirSync(path.dirname(toolLink), { recursive: true });
    symlinkSync(runtimePath, toolLink, "file");

    retainTargetTerminalNativeArtifacts({
      resourcesRoot,
      targetPlatform: "win32",
      targetArch: "x64",
    });

    expect(existsSync(path.dirname(toolLink))).toBe(false);
  });

  it("rejects a native module for a foreign architecture", () => {
    writeFile(nodePtyBinding, peBinary(0xaa64));

    expect(() =>
      attestPackagedTerminalArtifacts({
        resourcesRoot,
        runtimePath,
        targetPlatform: "win32",
        targetArch: "x64",
        runLoadProbe: () => ({
          platform: "win32",
          arch: "x64",
          modulesAbi: "127",
          hostReady: true,
          nativeModules: [
            { packageName: "node-pty", path: nodePtyBinding },
            { packageName: "koffi", path: koffiBinding },
          ],
        }),
      }),
    ).toThrow("expected x64, found arm64");
  });

  it("rejects a package when the PTY host bundle is missing", () => {
    rmSync(
      path.join(resourcesRoot, "app.asar.unpacked/dist/server/pty-host.cjs"),
    );

    expect(() =>
      attestPackagedTerminalArtifacts({
        resourcesRoot,
        runtimePath,
        targetPlatform: "win32",
        targetArch: "x64",
        runLoadProbe: () => {
          throw new Error("probe must not run");
        },
      }),
    ).toThrow("Packaged PTY host bundle is missing");
  });

  it("rejects terminal artifacts above the compressed size limit", () => {
    expect(() =>
      attestPackagedTerminalArtifacts({
        resourcesRoot,
        runtimePath,
        targetPlatform: "win32",
        targetArch: "x64",
        maxCompressedBytes: 1,
        runLoadProbe: () => ({
          platform: "win32",
          arch: "x64",
          modulesAbi: "127",
          hostReady: true,
          nativeModules: [
            { packageName: "node-pty", path: nodePtyBinding },
            { packageName: "koffi", path: koffiBinding },
          ],
        }),
      }),
    ).toThrow("compressed size");
  });

  it("rejects an unbounded package file before reading or compressing it", () => {
    writeFile(
      path.join(nodePtyRoot, "oversized.bin"),
      Buffer.alloc(16 * 1024 * 1024 + 1),
    );

    expect(() =>
      retainTargetTerminalNativeArtifacts({
        resourcesRoot,
        targetPlatform: "win32",
        targetArch: "x64",
      }),
    ).toThrow("package file exceeds");
  });

  it("rejects an unbounded total package size", () => {
    for (let index = 0; index < 9; index += 1) {
      const filePath = path.join(nodePtyRoot, `large-${index}.bin`);
      writeFile(filePath, "");
      truncateSync(filePath, 15 * 1024 * 1024);
    }

    expect(() =>
      retainTargetTerminalNativeArtifacts({
        resourcesRoot,
        targetPlatform: "win32",
        targetArch: "x64",
      }),
    ).toThrow("uncompressed bytes");
  });

  it("rejects unbounded package directory fan-out", () => {
    const fanOutRoot = path.join(nodePtyRoot, "fan-out");
    for (let index = 0; index < 513; index += 1) {
      mkdirSync(path.join(fanOutRoot, String(index)), { recursive: true });
    }

    expect(() =>
      retainTargetTerminalNativeArtifacts({
        resourcesRoot,
        targetPlatform: "win32",
        targetArch: "x64",
      }),
    ).toThrow("directories");
  });

  it("rejects a load probe that did not start the packaged PTY host", () => {
    expect(() =>
      attestPackagedTerminalArtifacts({
        resourcesRoot,
        runtimePath,
        targetPlatform: "win32",
        targetArch: "x64",
        runLoadProbe: () => ({
          platform: "win32",
          arch: "x64",
          modulesAbi: "127",
          hostReady: false,
          nativeModules: [],
        }),
      }),
    ).toThrow("did not start the PTY host bundle");
  });
});
