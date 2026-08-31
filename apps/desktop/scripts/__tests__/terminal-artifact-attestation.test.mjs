import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  attestPackagedTerminalArtifacts,
  parseLoadProbeProcessResult,
  retainTargetTerminalNativeArtifacts,
} from "../desktop-packaging/package-validation/terminal-artifact-attestation.mjs";

function writeFile(filePath, value) {
  NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
  NodeFS.writeFileSync(filePath, value);
}

function peBinary(machine) {
  const bytes = Buffer.alloc(128);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(64, 0x3c);
  bytes.write("PE\0\0", 64, "binary");
  bytes.writeUInt16LE(machine, 68);
  return bytes;
}

function elfBinary(machine) {
  const bytes = Buffer.alloc(64);
  bytes.write("\x7fELF", 0, "binary");
  bytes.writeUInt8(2, 4);
  bytes.writeUInt8(1, 5);
  bytes.writeUInt16LE(machine, 18);
  return bytes;
}

function machOBinary(cpuType) {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32BE(0xfeedfacf, 0);
  bytes.writeUInt32BE(cpuType, 4);
  return bytes;
}

describe("attestPackagedTerminalArtifacts", () => {
  it("accepts valid probe evidence independently of the child shutdown status", () => {
    expect(
      parseLoadProbeProcessResult({
        error: undefined,
        signal: null,
        status: 1,
        stderr: "",
        stdout: JSON.stringify({ hostReady: true }),
      }),
    ).toEqual({ hostReady: true });
  });

  it("reports process diagnostics when the probe emits no evidence", () => {
    expect(() =>
      parseLoadProbeProcessResult({
        error: undefined,
        signal: "SIGTERM",
        status: null,
        stderr: "host stopped",
        stdout: "",
      }),
    ).toThrow("signal SIGTERM: host stopped");
  });

  it("does not treat a post-readiness shutdown status as a startup failure", () => {
    const source = NodeFS.readFileSync(
      new URL("../desktop-packaging/package-validation/terminal-artifact-attestation.mjs", import.meta.url),
      "utf8",
    );

    expect(source).toContain("if (!hostReady) {");
    expect(source).not.toContain("if (!hostReady || code !== 0) {");
    expect(source).toContain("process.stdout.write(result, () => process.exit(0));");
  });

  let resourcesRoot;
  let nodePtyRoot;
  let koffiRoot;
  let runtimePath;
  let nodePtyBinding;
  let koffiBinding;

  beforeEach(() => {
    resourcesRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-terminal-package-"));
    nodePtyRoot = NodePath.join(
      resourcesRoot,
      "app.asar.unpacked/node_modules/node-pty",
    );
    koffiRoot = NodePath.join(
      resourcesRoot,
      "app.asar.unpacked/node_modules/koffi",
    );
    runtimePath = NodePath.join(resourcesRoot, "bin/mcode-server.exe");
    nodePtyBinding = NodePath.join(nodePtyRoot, "build/Release/conpty.node");
    koffiBinding = NodePath.join(koffiRoot, "build/koffi/win32_x64/koffi.node");

    writeFile(runtimePath, "runtime");
    writeFile(
      NodePath.join(resourcesRoot, "app.asar.unpacked/dist/server/pty-host.cjs"),
      "require('node-pty'); require('koffi');",
    );
    writeFile(
      NodePath.join(nodePtyRoot, "package.json"),
      '{"name":"node-pty","version":"1.0.0"}',
    );
    writeFile(
      NodePath.join(koffiRoot, "package.json"),
      '{"name":"koffi","version":"2.16.1"}',
    );
    writeFile(nodePtyBinding, peBinary(0x8664));
    writeFile(koffiBinding, peBinary(0x8664));
    writeFile(
      NodePath.join(nodePtyRoot, "build/Release/conpty/conpty.dll"),
      peBinary(0x8664),
    );
    writeFile(
      NodePath.join(nodePtyRoot, "build/Release/conpty/OpenConsole.exe"),
      peBinary(0x8664),
    );
  });

  afterEach(() => {
    NodeFS.rmSync(resourcesRoot, { recursive: true, force: true });
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
        nodeVersion: "22.18.0",
        electronVersion: "35.7.5",
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
      runtime: { node: "22.18.0", electron: "35.7.5" },
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
      NodePath.join(nodePtyRoot, "prebuilds/win32-arm64/conpty.node"),
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
          nodeVersion: "22.18.0",
          electronVersion: "35.7.5",
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
    const foreignBinding = NodePath.join(
      nodePtyRoot,
      "prebuilds/win32-arm64/conpty.node",
    );
    const foreignKoffi = NodePath.join(
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

    expect(NodeFS.existsSync(nodePtyBinding)).toBe(true);
    expect(NodeFS.existsSync(koffiBinding)).toBe(true);
    expect(NodeFS.existsSync(foreignBinding)).toBe(false);
    expect(NodeFS.existsSync(foreignKoffi)).toBe(false);
  });

  it("attests a Linux package without the macOS-only spawn helper", () => {
    const linuxNodePtyBinding = NodePath.join(
      nodePtyRoot,
      "build/Release/pty.node",
    );
    const linuxKoffiBinding = NodePath.join(
      koffiRoot,
      "build/koffi/linux_x64/koffi.node",
    );
    writeFile(linuxNodePtyBinding, elfBinary(62));
    writeFile(linuxKoffiBinding, elfBinary(62));

    retainTargetTerminalNativeArtifacts({
      resourcesRoot,
      targetPlatform: "linux",
      targetArch: "x64",
    });

    const report = attestPackagedTerminalArtifacts({
      resourcesRoot,
      runtimePath,
      targetPlatform: "linux",
      targetArch: "x64",
      runLoadProbe: () => ({
        platform: "linux",
        arch: "x64",
        modulesAbi: "127",
        nodeVersion: "22.18.0",
        electronVersion: "35.7.5",
        hostReady: true,
        nativeModules: [
          { packageName: "node-pty", path: linuxNodePtyBinding },
          { packageName: "koffi", path: linuxKoffiBinding },
        ],
      }),
    });

    expect(report.artifacts.map((artifact) => artifact.kind)).toEqual([
      "pty-host",
      "node-pty",
      "koffi",
    ]);
  });

  it("gives a Rosetta artifact probe the shared packaged-runtime startup budget", () => {
    const darwinNodePtyBinding = NodePath.join(
      nodePtyRoot,
      "build/Release/pty.node",
    );
    const darwinSpawnHelper = NodePath.join(
      nodePtyRoot,
      "build/Release/spawn-helper",
    );
    const darwinKoffiBinding = NodePath.join(
      koffiRoot,
      "build/koffi/darwin_x64/koffi.node",
    );
    writeFile(darwinNodePtyBinding, machOBinary(0x01000007));
    writeFile(darwinSpawnHelper, machOBinary(0x01000007));
    writeFile(darwinKoffiBinding, machOBinary(0x01000007));

    retainTargetTerminalNativeArtifacts({
      resourcesRoot,
      targetPlatform: "darwin",
      targetArch: "x64",
    });

    let startupTimeoutMs;
    attestPackagedTerminalArtifacts({
      resourcesRoot,
      runtimePath,
      hostPlatform: "darwin",
      hostArch: "arm64",
      targetPlatform: "darwin",
      targetArch: "x64",
      runLoadProbe: (input) => {
        startupTimeoutMs = input.startupTimeoutMs;
        return {
          platform: "darwin",
          arch: "x64",
          modulesAbi: "127",
          nodeVersion: "22.18.0",
          electronVersion: "35.7.5",
          hostReady: true,
          nativeModules: [
            { packageName: "node-pty", path: darwinNodePtyBinding },
            { packageName: "koffi", path: darwinKoffiBinding },
          ],
        };
      },
    });

    expect(startupTimeoutMs).toBe(60_000);
  });

  it("retains a valid target prebuild when a stale rebuilt binding is foreign", () => {
    const targetPrebuild = NodePath.join(
      nodePtyRoot,
      "prebuilds/win32-x64/conpty.node",
    );
    writeFile(nodePtyBinding, peBinary(0xaa64));
    writeFile(targetPrebuild, peBinary(0x8664));
    writeFile(
      NodePath.join(nodePtyRoot, "prebuilds/win32-x64/conpty/conpty.dll"),
      peBinary(0x8664),
    );
    writeFile(
      NodePath.join(nodePtyRoot, "prebuilds/win32-x64/conpty/OpenConsole.exe"),
      peBinary(0x8664),
    );

    retainTargetTerminalNativeArtifacts({
      resourcesRoot,
      targetPlatform: "win32",
      targetArch: "x64",
    });

    expect(NodeFS.existsSync(nodePtyBinding)).toBe(false);
    expect(NodeFS.existsSync(targetPrebuild)).toBe(true);
  });

  it("removes node-gyp tool links before enforcing the package inventory", () => {
    const toolLink = NodePath.join(nodePtyRoot, "build/node_gyp_bins/python3");
    NodeFS.mkdirSync(NodePath.dirname(toolLink), { recursive: true });
    NodeFS.symlinkSync(runtimePath, toolLink, "file");

    retainTargetTerminalNativeArtifacts({
      resourcesRoot,
      targetPlatform: "win32",
      targetArch: "x64",
    });

    expect(NodeFS.existsSync(NodePath.dirname(toolLink))).toBe(false);
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
          nodeVersion: "22.18.0",
          electronVersion: "35.7.5",
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
    NodeFS.rmSync(
      NodePath.join(resourcesRoot, "app.asar.unpacked/dist/server/pty-host.cjs"),
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
          nodeVersion: "22.18.0",
          electronVersion: "35.7.5",
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
      NodePath.join(nodePtyRoot, "oversized.bin"),
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
      const filePath = NodePath.join(nodePtyRoot, `large-${index}.bin`);
      writeFile(filePath, "");
      NodeFS.truncateSync(filePath, 15 * 1024 * 1024);
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
    const fanOutRoot = NodePath.join(nodePtyRoot, "fan-out");
    for (let index = 0; index < 513; index += 1) {
      NodeFS.mkdirSync(NodePath.join(fanOutRoot, String(index)), { recursive: true });
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
          nodeVersion: "22.18.0",
          electronVersion: "35.7.5",
          hostReady: false,
          nativeModules: [],
        }),
      }),
    ).toThrow("did not start the PTY host bundle");
  });
});
