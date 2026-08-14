import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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

function writeProductEvidence(root) {
  const directory = path.join(root, "product-evidence");
  mkdirSync(directory, { recursive: true });
  const base = {
    contractVersion: 1,
    kind: "packaged-terminal-product-smoke",
    generatedAt: "2026-08-14T12:00:00.000Z",
    status: "passed",
    startupFallbackDurationMs: null,
    isolation: { mode: "linux-network-namespace", loopbackAllowed: true },
    renderer: { cols: 80, rows: 24, cursor: { x: 1, y: 1 }, lines: [{ text: "MCODE", wrapped: true }], normalizedLines: ["MCODE"] },
    workload: { id: "process-cleanup", synchronizationMarker: "WF:cleanup:parent" },
    cleanup: { pids: [1, 2, 3], hostPids: [3], aliveAfterCleanup: [], cleanupDurationMs: 1, passed: true },
    packageHashesBefore: { "resources/app.asar": "a".repeat(64) },
    packageHashesAfter: { "resources/app.asar": "a".repeat(64) },
  };
  const modern = { contractVersion: 1, backend: "modern", host: { state: "healthy", generation: "1" }, releaseTest: { hostPid: 3 } };
  const write = (name, receipt) => writeFileSync(path.join(directory, name), JSON.stringify(receipt));
  write("clean.json", { ...base, fault: null, observations: { capabilities: { initial: modern, history: [modern] }, sessions: [], retry: null, newSession: null, typedErrors: [] } });
  for (const [fault, name] of [["startup-health-failure", "fault-startup-health-failure.json"], ["missing-native-artifact", "fault-missing-native-artifact.json"]]) {
    write(name, { ...base, fault, startupFallbackDurationMs: 1200, observations: { capabilities: { initial: { contractVersion: 0, backend: "legacy" }, history: [{ contractVersion: 0, backend: "legacy" }] }, sessions: [], retry: modern, newSession: null, typedErrors: [] } });
  }
  for (const [fault, name] of [["post-start-host-exit", "fault-post-start-host-exit.json"], ["containment-failure", "fault-containment-failure.json"]]) {
    const replacement = { ...modern, host: { state: "healthy", generation: "2" } };
    write(name, { ...base, fault, observations: { capabilities: { initial: modern, history: [modern, replacement] }, sessions: [{ sessionId: "11111111-1111-4111-8111-111111111111", state: "failed", hostGeneration: "1", exitReason: "host-crash" }], retry: null, newSession: { sessionId: "22222222-2222-4222-8222-222222222222", state: "running", hostGeneration: "2", exitReason: null }, typedErrors: ["HOST_UNHEALTHY"] } });
  }
  return directory;
}

function createMacTargetFixture(root) {
  const releaseDir = path.join(root, "release");
  const appPath = path.join(
    releaseDir,
    "mac-arm64",
    "Mcode.app",
    "Contents",
  );
  mkdirSync(path.join(appPath, "MacOS"), { recursive: true });
  mkdirSync(path.join(appPath, "Resources", "bin"), { recursive: true });
  writeFileSync(path.join(appPath, "MacOS", "Mcode"), "electron");
  writeFileSync(path.join(appPath, "Resources", "bin", "mcode-server"), "server");
  for (const file of TARGETS[2].files) {
    writeFileSync(path.join(releaseDir, file), file);
  }
  return releaseDir;
}

describe("Terminal release evidence", () => {
  let fixtureRoot;

  afterEach(() => {
    if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("stages exact target artifacts and records bounded signed evidence", () => {
    fixtureRoot = mkdtempSync(
      path.join(tmpdir(), "terminal-release-evidence-"),
    );
    const releaseDir = path.join(fixtureRoot, "release");
    const stagingDir = path.join(fixtureRoot, "stage", "windows-x64");
    const attestationPath = path.join(fixtureRoot, "attestation.json");
    mkdirSync(releaseDir, { recursive: true });
    for (const file of TARGETS[0].files)
      writeFileSync(path.join(releaseDir, file), file);
    writeFileSync(attestationPath, JSON.stringify(attestation("win32", "x64")));

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
      productEvidenceDir: writeProductEvidence(fixtureRoot),
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
    fixtureRoot = mkdtempSync(
      path.join(tmpdir(), "terminal-release-metadata-filter-"),
    );
    const releaseDir = path.join(fixtureRoot, "release");
    const stagingDir = path.join(fixtureRoot, "stage", "windows-x64");
    const attestationPath = path.join(fixtureRoot, "attestation.json");
    mkdirSync(releaseDir, { recursive: true });
    for (const file of [
      ...TARGETS[0].files,
      "latest.yml",
      "builder-debug.yml",
    ]) {
      writeFileSync(path.join(releaseDir, file), file);
    }
    writeFileSync(attestationPath, JSON.stringify(attestation("win32", "x64")));

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
      productEvidenceDir: writeProductEvidence(fixtureRoot),
      signatureVerifier: ({ platform }) => passedSignatures(platform),
    });

    expect(manifest.artifacts.map((artifact) => artifact.name)).toContain(
      "latest.yml",
    );
    expect(manifest.artifacts.map((artifact) => artifact.name)).not.toContain(
      "builder-debug.yml",
    );
    expect(existsSync(path.join(stagingDir, "latest.yml"))).toBe(true);
    expect(existsSync(path.join(stagingDir, "builder-debug.yml"))).toBe(false);
  });

  it("runs full final-package Terminal attestation when no report is supplied", () => {
    fixtureRoot = mkdtempSync(path.join(tmpdir(), "terminal-final-attestation-"));
    const releaseDir = path.join(fixtureRoot, "release");
    const stagingDir = path.join(fixtureRoot, "stage", "linux-x64");
    mkdirSync(releaseDir, { recursive: true });
    for (const file of TARGETS[3].files)
      writeFileSync(path.join(releaseDir, file), file);
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
      productEvidenceDir: writeProductEvidence(fixtureRoot),
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
      resourcesRoot: path.join(releaseDir, "linux-unpacked", "resources"),
      runtimePath: path.join(
        releaseDir,
        "linux-unpacked",
        "resources",
        "bin",
        "mcode-server",
      ),
    });
  });

  it("selects the executable that matches macOS signing state for final attestation", () => {
    fixtureRoot = mkdtempSync(path.join(tmpdir(), "terminal-macos-runtime-"));
    const releaseDir = createMacTargetFixture(fixtureRoot);
    const calls = [];

    for (const [signingRequired, expectedRuntime] of [
      [false, path.join(releaseDir, "mac-arm64", "Mcode.app", "Contents", "MacOS", "Mcode")],
      [true, path.join(releaseDir, "mac-arm64", "Mcode.app", "Contents", "Resources", "bin", "mcode-server")],
    ]) {
      createTargetEvidenceManifest({
        releaseDir,
        stagingDir: path.join(
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
        productEvidenceDir: writeProductEvidence(fixtureRoot),
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
    fixtureRoot = mkdtempSync(path.join(tmpdir(), "terminal-release-matrix-"));
    const inputDir = path.join(fixtureRoot, "stage");
    const productEvidenceDir = writeProductEvidence(fixtureRoot);
    for (const target of TARGETS) {
      const releaseDir = path.join(
        fixtureRoot,
        `release-${target.platform}-${target.arch}`,
      );
      const stagingDir = path.join(
        inputDir,
        `${target.platform}-${target.arch}`,
      );
      const attestationPath = path.join(
        fixtureRoot,
        `attestation-${target.platform}-${target.arch}.json`,
      );
      mkdirSync(releaseDir, { recursive: true });
      for (const file of target.files)
        writeFileSync(path.join(releaseDir, file), file);
      writeFileSync(
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
        productEvidenceDir,
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
    fixtureRoot = mkdtempSync(path.join(tmpdir(), "terminal-release-duplicate-"));
    const inputDir = path.join(fixtureRoot, "stage");

    for (const suffix of ["first", "second"]) {
      const releaseDir = path.join(fixtureRoot, `release-${suffix}`);
      const stagingDir = path.join(inputDir, suffix);
      const attestationPath = path.join(fixtureRoot, `attestation-${suffix}.json`);
      mkdirSync(releaseDir, { recursive: true });
      for (const file of TARGETS[3].files)
        writeFileSync(path.join(releaseDir, file), file);
      writeFileSync(
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
        productEvidenceDir: writeProductEvidence(fixtureRoot),
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
    fixtureRoot = mkdtempSync(path.join(tmpdir(), "terminal-release-tamper-"));
    const releaseDir = path.join(fixtureRoot, "release");
    const stagingDir = path.join(fixtureRoot, "stage", "linux-x64");
    const attestationPath = path.join(fixtureRoot, "attestation.json");
    mkdirSync(releaseDir, { recursive: true });
    for (const file of TARGETS[3].files)
      writeFileSync(path.join(releaseDir, file), file);
    writeFileSync(attestationPath, JSON.stringify(attestation("linux", "x64")));
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
      productEvidenceDir: writeProductEvidence(fixtureRoot),
      signatureVerifier: () => [
        { kind: "release-key", status: "skipped", subject: "SHA256SUMS.sig" },
      ],
    });
    writeFileSync(path.join(stagingDir, TARGETS[3].files[0]), "changed");

    expect(() =>
      createReleaseEvidenceManifest({
        inputDir: path.dirname(stagingDir),
        channel: "pull-request",
      }),
    ).toThrow("hash mismatch");
  });
});
