import { afterEach, describe, expect, it } from "vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  createReleaseEvidenceManifest,
  createTargetEvidenceManifest,
} from "../desktop-packaging/package-validation/terminal-release-evidence.mjs";

const COMMIT = "a".repeat(40);
const TARGETS = [
  {
    platform: "windows",
    nativePlatform: "win32",
    arch: "x64",
    files: ["Mcode-Setup-0.13.0.exe", "Mcode-0.13.0-win.zip"],
  },
  {
    platform: "macos",
    nativePlatform: "darwin",
    arch: "x64",
    files: ["Mcode-0.13.0-x64.dmg", "Mcode-0.13.0-x64.zip"],
  },
  {
    platform: "macos",
    nativePlatform: "darwin",
    arch: "arm64",
    files: ["Mcode-0.13.0-arm64.dmg", "Mcode-0.13.0-arm64.zip"],
  },
  {
    platform: "linux",
    nativePlatform: "linux",
    arch: "x64",
    files: ["Mcode-0.13.0.AppImage", "mcode_0.13.0_amd64.deb"],
  },
];

function attestation(platform, arch) {
  return {
    contractVersion: 1,
    target: { platform, arch, modulesAbi: "127" },
    runtime: { node: "22.18.0", electron: "35.7.5" },
    dependencies: { "node-pty": "1.0.0", koffi: "2.16.1" },
    compressedBytes: 30,
    compressedLimitBytes: 10_485_760,
    packageFileCount: 3,
    artifacts: ["pty-host", "node-pty", "koffi"].map((kind, index) => ({
      kind,
      path: `${kind}.bin`,
      origin: "fixture",
      ...(kind === "pty-host" ? {} : { architecture: arch, modulesAbi: "127" }),
      bytes: 10,
      compressedBytes: 10,
      sha256: String(index + 1).repeat(64),
    })),
  };
}

function passedSignatures(platform) {
  if (platform === "windows")
    return [{ kind: "authenticode", status: "passed", subject: "Mcode.exe" }];
  if (platform === "linux")
    return [
      { kind: "release-key", status: "passed", subject: "SHA256SUMS.sig" },
    ];
  return [
    { kind: "developer-id", status: "passed", subject: "Mcode.app" },
    { kind: "notarization", status: "passed", subject: "Mcode.dmg" },
    { kind: "staple", status: "passed", subject: "Mcode.dmg" },
    { kind: "gatekeeper", status: "passed", subject: "Mcode.app" },
  ];
}

function createMacTargetFixture(root) {
  const releaseDir = NodePath.join(root, "release");
  const appPath = NodePath.join(
    releaseDir,
    "mac-arm64",
    "Mcode.app",
    "Contents",
  );
  NodeFS.mkdirSync(NodePath.join(appPath, "MacOS"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(appPath, "Resources", "bin"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(appPath, "MacOS", "Mcode"), "electron");
  NodeFS.writeFileSync(NodePath.join(appPath, "Resources", "bin", "mcode-server"), "server");
  for (const file of TARGETS[2].files) {
    NodeFS.writeFileSync(NodePath.join(releaseDir, file), file);
  }
  return releaseDir;
}

describe("Terminal release evidence", () => {
  let fixtureRoot;

  afterEach(() => {
    if (fixtureRoot) NodeFS.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("stages exact target artifacts and records bounded signed evidence", () => {
    fixtureRoot = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "terminal-release-evidence-"),
    );
    const releaseDir = NodePath.join(fixtureRoot, "release");
    const stagingDir = NodePath.join(fixtureRoot, "stage", "windows-x64");
    const attestationPath = NodePath.join(fixtureRoot, "attestation.json");
    NodeFS.mkdirSync(releaseDir, { recursive: true });
    for (const file of TARGETS[0].files)
      NodeFS.writeFileSync(NodePath.join(releaseDir, file), file);
    NodeFS.writeFileSync(attestationPath, JSON.stringify(attestation("win32", "x64")));

    const manifest = createTargetEvidenceManifest({
      releaseDir,
      stagingDir,
      attestationPath,
      commit: COMMIT,
      version: "0.13.0",
      channel: "stable",
      expectedLegacy: true,
      targetPlatform: "windows",
      targetArch: "x64",
      runner: "windows-2025",
      signingRequired: true,
      generatedAt: "2026-08-12T12:00:00.000Z",
      signatureVerifier: ({ platform }) => passedSignatures(platform),
    });

    expect(manifest.artifacts.map((artifact) => artifact.kind).sort()).toEqual([
      "nsis",
      "zip",
    ]);
    expect(manifest.signatures).toEqual(passedSignatures("windows"));
    expect(
      manifest.artifacts.every((artifact) =>
        /^[a-f0-9]{64}$/.test(artifact.sha256),
      ),
    ).toBe(true);
  });

  it("stages supported updater metadata but excludes builder diagnostics", () => {
    fixtureRoot = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "terminal-release-metadata-filter-"),
    );
    const releaseDir = NodePath.join(fixtureRoot, "release");
    const stagingDir = NodePath.join(fixtureRoot, "stage", "windows-x64");
    const attestationPath = NodePath.join(fixtureRoot, "attestation.json");
    NodeFS.mkdirSync(releaseDir, { recursive: true });
    for (const file of [
      ...TARGETS[0].files,
      "latest.yml",
      "builder-debug.yml",
    ]) {
      NodeFS.writeFileSync(NodePath.join(releaseDir, file), file);
    }
    NodeFS.writeFileSync(attestationPath, JSON.stringify(attestation("win32", "x64")));

    const manifest = createTargetEvidenceManifest({
      releaseDir,
      stagingDir,
      attestationPath,
      commit: COMMIT,
      version: "0.13.0",
      channel: "stable",
      expectedLegacy: true,
      targetPlatform: "windows",
      targetArch: "x64",
      runner: "windows-2025",
      signingRequired: true,
      signatureVerifier: ({ platform }) => passedSignatures(platform),
    });

    expect(manifest.artifacts.map((artifact) => artifact.name)).toContain(
      "latest.yml",
    );
    expect(manifest.artifacts.map((artifact) => artifact.name)).not.toContain(
      "builder-debug.yml",
    );
    expect(NodeFS.existsSync(NodePath.join(stagingDir, "latest.yml"))).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(stagingDir, "builder-debug.yml"))).toBe(false);
  });

  it("runs full final-package Terminal attestation when no report is supplied", () => {
    fixtureRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "terminal-final-attestation-"));
    const releaseDir = NodePath.join(fixtureRoot, "release");
    const stagingDir = NodePath.join(fixtureRoot, "stage", "linux-x64");
    NodeFS.mkdirSync(releaseDir, { recursive: true });
    for (const file of TARGETS[3].files)
      NodeFS.writeFileSync(NodePath.join(releaseDir, file), file);
    const calls = [];
    const manifest = createTargetEvidenceManifest({
      releaseDir,
      stagingDir,
      commit: COMMIT,
      version: "0.13.0",
      channel: "pull-request",
      expectedLegacy: true,
      targetPlatform: "linux",
      targetArch: "x64",
      runner: "ubuntu-24.04",
      signingRequired: false,
      signatureVerifier: () => [
        { kind: "release-key", status: "skipped", subject: "SHA256SUMS.sig" },
      ],
      terminalAttester: (input) => {
        calls.push(input);
        return attestation("linux", "x64");
      },
    });

    expect(manifest.terminal.target).toMatchObject({ platform: "linux", arch: "x64" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      targetPlatform: "linux",
      targetArch: "x64",
      resourcesRoot: NodePath.join(releaseDir, "linux-unpacked", "resources"),
      runtimePath: NodePath.join(
        releaseDir,
        "linux-unpacked",
        "resources",
        "bin",
        "mcode-server",
      ),
    });
  });

  it("selects the executable that matches macOS signing state for final attestation", () => {
    fixtureRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "terminal-macos-runtime-"));
    const releaseDir = createMacTargetFixture(fixtureRoot);
    const calls = [];

    for (const [signingRequired, expectedRuntime] of [
      [false, NodePath.join(releaseDir, "mac-arm64", "Mcode.app", "Contents", "MacOS", "Mcode")],
      [true, NodePath.join(releaseDir, "mac-arm64", "Mcode.app", "Contents", "Resources", "bin", "mcode-server")],
    ]) {
      createTargetEvidenceManifest({
        releaseDir,
        stagingDir: NodePath.join(
          fixtureRoot,
          "stage",
          signingRequired ? "signed" : "unsigned",
        ),
        commit: COMMIT,
        version: "0.13.0",
        channel: "pull-request",
        expectedLegacy: true,
        targetPlatform: "macos",
        targetArch: "arm64",
        runner: "macos-14",
        signingRequired,
        signatureVerifier: () => passedSignatures("macos"),
        terminalAttester: (input) => {
          calls.push(input);
          return attestation("darwin", "arm64");
        },
      });
      expect(calls.at(-1).runtimePath).toBe(expectedRuntime);
    }
  });

  it("requires a complete, consistent target matrix before aggregate publication", () => {
    fixtureRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "terminal-release-matrix-"));
    const inputDir = NodePath.join(fixtureRoot, "stage");
    for (const target of TARGETS) {
      const releaseDir = NodePath.join(
        fixtureRoot,
        `release-${target.platform}-${target.arch}`,
      );
      const stagingDir = NodePath.join(
        inputDir,
        `${target.platform}-${target.arch}`,
      );
      const attestationPath = NodePath.join(
        fixtureRoot,
        `attestation-${target.platform}-${target.arch}.json`,
      );
      NodeFS.mkdirSync(releaseDir, { recursive: true });
      for (const file of target.files)
        NodeFS.writeFileSync(NodePath.join(releaseDir, file), file);
      NodeFS.writeFileSync(
        attestationPath,
        JSON.stringify(attestation(target.nativePlatform, target.arch)),
      );
      createTargetEvidenceManifest({
        releaseDir,
        stagingDir,
        attestationPath,
        commit: COMMIT,
        version: "0.13.0-nightly.20260812.1",
        channel: "pull-request",
        expectedLegacy: true,
        targetPlatform: target.platform,
        targetArch: target.arch,
        runner: `${target.platform}-runner`,
        signingRequired: true,
        generatedAt: "2026-08-12T12:00:00.000Z",
        signatureVerifier: ({ platform }) => passedSignatures(platform),
      });
    }

    const aggregate = createReleaseEvidenceManifest({
      inputDir,
      channel: "pull-request",
      generatedAt: "2026-08-12T13:00:00.000Z",
    });

    expect(aggregate.targets.map((target) => target.targetId)).toEqual([
      "linux-x64",
      "macos-arm64",
      "macos-x64",
      "windows-x64",
    ]);
    expect(aggregate.nativeDependencies).toEqual({
      "node-pty": "1.0.0",
      koffi: "2.16.1",
    });
  });

  it("rejects duplicate target manifests before checking matrix completeness", () => {
    fixtureRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "terminal-release-duplicate-"));
    const inputDir = NodePath.join(fixtureRoot, "stage");

    for (const suffix of ["first", "second"]) {
      const releaseDir = NodePath.join(fixtureRoot, `release-${suffix}`);
      const stagingDir = NodePath.join(inputDir, suffix);
      const attestationPath = NodePath.join(fixtureRoot, `attestation-${suffix}.json`);
      NodeFS.mkdirSync(releaseDir, { recursive: true });
      for (const file of TARGETS[3].files)
        NodeFS.writeFileSync(NodePath.join(releaseDir, file), file);
      NodeFS.writeFileSync(
        attestationPath,
        JSON.stringify(attestation(TARGETS[3].nativePlatform, TARGETS[3].arch)),
      );
      createTargetEvidenceManifest({
        releaseDir,
        stagingDir,
        attestationPath,
        commit: COMMIT,
        version: "0.13.0",
        channel: "pull-request",
        expectedLegacy: true,
        targetPlatform: TARGETS[3].platform,
        targetArch: TARGETS[3].arch,
        runner: "ubuntu-24.04",
        signingRequired: false,
        signatureVerifier: () => [
          { kind: "release-key", status: "skipped", subject: "SHA256SUMS.sig" },
        ],
      });
    }

    expect(() =>
      createReleaseEvidenceManifest({
        inputDir,
        channel: "pull-request",
      }),
    ).toThrow("Duplicate release target: linux-x64");
  });

  it("rejects a staged artifact after its bytes change", () => {
    fixtureRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "terminal-release-tamper-"));
    const releaseDir = NodePath.join(fixtureRoot, "release");
    const stagingDir = NodePath.join(fixtureRoot, "stage", "linux-x64");
    const attestationPath = NodePath.join(fixtureRoot, "attestation.json");
    NodeFS.mkdirSync(releaseDir, { recursive: true });
    for (const file of TARGETS[3].files)
      NodeFS.writeFileSync(NodePath.join(releaseDir, file), file);
    NodeFS.writeFileSync(attestationPath, JSON.stringify(attestation("linux", "x64")));
    createTargetEvidenceManifest({
      releaseDir,
      stagingDir,
      attestationPath,
      commit: COMMIT,
      version: "0.13.0",
      channel: "pull-request",
      expectedLegacy: true,
      targetPlatform: "linux",
      targetArch: "x64",
      runner: "ubuntu-24.04",
      signingRequired: false,
      signatureVerifier: () => [
        { kind: "release-key", status: "skipped", subject: "SHA256SUMS.sig" },
      ],
    });
    NodeFS.writeFileSync(NodePath.join(stagingDir, TARGETS[3].files[0]), "changed");

    expect(() =>
      createReleaseEvidenceManifest({
        inputDir: NodePath.dirname(stagingDir),
        channel: "pull-request",
      }),
    ).toThrow("hash mismatch");
  });
});
