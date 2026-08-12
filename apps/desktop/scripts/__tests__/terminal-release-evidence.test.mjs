import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createReleaseEvidenceManifest,
  createTargetEvidenceManifest,
} from "../terminal-release-evidence.mjs";

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

  it("requires a complete, consistent target matrix before aggregate publication", () => {
    fixtureRoot = mkdtempSync(path.join(tmpdir(), "terminal-release-matrix-"));
    const inputDir = path.join(fixtureRoot, "stage");
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
        channel: "nightly",
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
      channel: "nightly",
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
