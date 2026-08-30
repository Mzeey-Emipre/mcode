import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  TerminalArtifactAttestationSchema,
  TerminalReleaseEvidenceManifestSchema,
  TerminalTargetEvidenceManifestSchema,
} from "../../../../../packages/contracts/src/models/terminal-diagnostics.ts";
import { attestPackagedTerminalArtifacts } from "./terminal-artifact-attestation.mjs";
import { SUPPORTED_DESKTOP_TARGETS } from "../target-inventory/target-inventory.mjs";

const MANIFEST_NAME = "terminal-target-manifest.json";
const AGGREGATE_NAME = "terminal-release-manifest.json";
const MAX_DISCOVERED_FILES = 128;
const TARGET_PLATFORM = { win32: "windows", darwin: "macos", linux: "linux" };
const REQUIRED_KINDS = {
  windows: ["nsis", "zip"],
  macos: ["dmg", "zip"],
  linux: ["appimage", "deb"],
};
const COMPLETE_TARGETS = SUPPORTED_DESKTOP_TARGETS.map(({ id }) => id);
const UPDATE_METADATA_FILENAMES = new Set([
  "latest.yml",
  "latest-linux.yml",
  "latest-mac.yml",
  "nightly.yml",
  "nightly-linux.yml",
  "nightly-mac.yml",
]);
const requireFromWeb = createRequire(
  path.resolve(import.meta.dirname, "../../../../web/package.json"),
);

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function writeJsonAtomic(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
  });
  renameSync(temporaryPath, filePath);
}

function artifactKind(fileName) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".exe")) return "nsis";
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".dmg")) return "dmg";
  if (lower.endsWith(".appimage")) return "appimage";
  if (lower.endsWith(".deb")) return "deb";
  if (lower.endsWith(".blockmap")) return "blockmap";
  if (UPDATE_METADATA_FILENAMES.has(lower)) return "update-metadata";
  if (fileName === "SHA256SUMS") return "sha256-manifest";
  if (fileName === "SHA256SUMS.sig") return "sha256-signature";
  return undefined;
}

function listReleaseFiles(releaseDir) {
  const entries = readdirSync(releaseDir, { withFileTypes: true });
  if (entries.length > MAX_DISCOVERED_FILES) {
    throw new Error(
      `Release directory contains more than ${MAX_DISCOVERED_FILES} entries`,
    );
  }
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name !== "elevate.exe" &&
        artifactKind(entry.name),
    )
    .map((entry) => path.join(releaseDir, entry.name));
}

function assertRequiredKinds(platform, artifacts) {
  const kinds = new Set(artifacts.map((artifact) => artifact.kind));
  for (const requiredKind of REQUIRED_KINDS[platform]) {
    if (!kinds.has(requiredKind)) {
      throw new Error(
        `Missing required ${platform} release artifact: ${requiredKind}`,
      );
    }
  }
}

function run(command, args) {
  execFileSync(command, args, { stdio: "pipe", encoding: "utf8" });
}

function findMacApp(releaseDir, arch) {
  const candidates =
    arch === "arm64" ? ["mac-arm64", "mac"] : ["mac", "mac-x64"];
  for (const directory of candidates) {
    const appPath = path.join(releaseDir, directory, "Mcode.app");
    if (existsSync(appPath)) return appPath;
  }
  throw new Error(`Packaged macOS application is missing for ${arch}`);
}

function attestFinalPackage(
  releaseDir,
  platform,
  arch,
  signingRequired,
  terminalAttester = attestPackagedTerminalArtifacts,
) {
  if (platform === "windows") {
    const resourcesRoot = path.join(releaseDir, "win-unpacked", "resources");
    return terminalAttester({
      resourcesRoot,
      runtimePath: path.join(resourcesRoot, "bin", "mcode-server.exe"),
      targetPlatform: "win32",
      targetArch: arch,
    });
  }
  if (platform === "linux") {
    const resourcesRoot = path.join(releaseDir, "linux-unpacked", "resources");
    return terminalAttester({
      resourcesRoot,
      runtimePath: path.join(resourcesRoot, "bin", "mcode-server"),
      targetPlatform: "linux",
      targetArch: arch,
    });
  }
  const appPath = findMacApp(releaseDir, arch);
  const resourcesRoot = path.join(appPath, "Contents", "Resources");
  return terminalAttester({
    resourcesRoot,
    runtimePath: signingRequired
      ? path.join(resourcesRoot, "bin", "mcode-server")
      : path.join(appPath, "Contents", "MacOS", "Mcode"),
    targetPlatform: "darwin",
    targetArch: arch,
  });
}

function signLinuxChecks(releaseDir, signingRequired) {
  const primary = listReleaseFiles(releaseDir);
  const sumsPath = path.join(releaseDir, "SHA256SUMS");
  const sums = primary
    .sort((left, right) =>
      path.basename(left).localeCompare(path.basename(right)),
    )
    .map((filePath) => `${sha256File(filePath)}  ${path.basename(filePath)}`)
    .join("\n");
  writeFileSync(sumsPath, `${sums}\n`, { flag: "w" });
  const signaturePath = `${sumsPath}.sig`;
  if (!signingRequired) {
    return [
      {
        kind: "release-key",
        status: "skipped",
        subject: path.basename(signaturePath),
      },
    ];
  }
  const keyId = process.env.MCODE_LINUX_SIGNING_KEY_ID;
  if (!keyId)
    throw new Error(
      "MCODE_LINUX_SIGNING_KEY_ID is required for a signed Linux target",
    );
  run("gpg", [
    "--batch",
    "--yes",
    "--local-user",
    keyId,
    "--detach-sign",
    "--output",
    signaturePath,
    sumsPath,
  ]);
  run("gpg", ["--batch", "--verify", signaturePath, sumsPath]);
  return [
    {
      kind: "release-key",
      status: "passed",
      subject: path.basename(signaturePath),
    },
  ];
}

/** Verifies the platform signing evidence for one staged target. */
export function verifyTargetSignatures({
  releaseDir,
  platform,
  arch,
  signingRequired,
}) {
  if (platform === "linux") return signLinuxChecks(releaseDir, signingRequired);
  if (!signingRequired) {
    const kinds =
      platform === "windows"
        ? ["authenticode"]
        : ["developer-id", "notarization", "staple", "gatekeeper"];
    return kinds.map((kind) => ({
      kind,
      status: "skipped",
      subject: platform === "windows" ? "Mcode-Setup.exe" : "Mcode.app",
    }));
  }
  if (platform === "windows") {
    const installers = listReleaseFiles(releaseDir).filter(
      (filePath) => artifactKind(path.basename(filePath)) === "nsis",
    );
    const signedExecutables = [
      ...installers,
      path.join(releaseDir, "win-unpacked", "Mcode.exe"),
      path.join(
        releaseDir,
        "win-unpacked",
        "resources",
        "bin",
        "mcode-server.exe",
      ),
    ];
    for (const executable of signedExecutables) {
      if (!existsSync(executable))
        throw new Error(`Signed Windows executable is missing: ${executable}`);
      run("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "& { param([string]$Target) $signature = Get-AuthenticodeSignature -LiteralPath $Target; if ($signature.Status -ne 'Valid') { throw \"Authenticode status: $($signature.Status)\" } }",
        executable,
      ]);
    }
    return signedExecutables.map((executable) => ({
      kind: "authenticode",
      status: "passed",
      subject: path.basename(executable),
    }));
  }
  const appPath = findMacApp(releaseDir, arch);
  run("codesign", ["--verify", "--deep", "--strict", appPath]);
  const serverPath = path.join(
    appPath,
    "Contents",
    "Resources",
    "bin",
    "mcode-server",
  );
  run("codesign", ["--verify", "--strict", serverPath]);
  run("spctl", ["--assess", "--type", "execute", appPath]);
  const dmgs = listReleaseFiles(releaseDir).filter(
    (filePath) => artifactKind(path.basename(filePath)) === "dmg",
  );
  for (const dmg of dmgs) run("xcrun", ["stapler", "validate", dmg]);
  return [
    { kind: "developer-id", status: "passed", subject: "Mcode.app" },
    { kind: "developer-id", status: "passed", subject: "mcode-server" },
    { kind: "notarization", status: "passed", subject: path.basename(dmgs[0]) },
    { kind: "staple", status: "passed", subject: path.basename(dmgs[0]) },
    { kind: "gatekeeper", status: "passed", subject: "Mcode.app" },
  ];
}

function stageArtifacts(releaseDir, stagingDir) {
  mkdirSync(stagingDir, { recursive: true });
  return listReleaseFiles(releaseDir).map((sourcePath) => {
    if (lstatSync(sourcePath).isSymbolicLink())
      throw new Error(
        `Release artifact cannot be a symbolic link: ${sourcePath}`,
      );
    const name = path.basename(sourcePath);
    const destinationPath = path.join(stagingDir, name);
    copyFileSync(sourcePath, destinationPath, 0);
    const stats = statSync(destinationPath);
    return {
      name,
      kind: artifactKind(name),
      bytes: stats.size,
      sha256: sha256File(destinationPath),
    };
  });
}

/** Builds and writes one target evidence manifest from exact staged artifacts. */
export function createTargetEvidenceManifest({
  releaseDir,
  stagingDir,
  attestationPath,
  commit,
  version,
  channel,
  expectedLegacy,
  targetPlatform,
  targetArch,
  runner,
  signingRequired,
  generatedAt = new Date().toISOString(),
  signatureVerifier = verifyTargetSignatures,
  terminalAttester = attestPackagedTerminalArtifacts,
}) {
  const platform = TARGET_PLATFORM[targetPlatform] ?? targetPlatform;
  if (!REQUIRED_KINDS[platform])
    throw new Error(`Unsupported release target platform: ${targetPlatform}`);
  const terminal = TerminalArtifactAttestationSchema().parse(
    attestationPath
      ? JSON.parse(readFileSync(attestationPath, "utf8"))
      : attestFinalPackage(
          releaseDir,
          platform,
          targetArch,
          signingRequired,
          terminalAttester,
        ),
  );
  const expectedAttestationPlatform = {
    windows: "win32",
    macos: "darwin",
    linux: "linux",
  }[platform];
  if (
    terminal.target.platform !== expectedAttestationPlatform ||
    terminal.target.arch !== targetArch
  ) {
    throw new Error(
      "Terminal attestation target does not match the release target",
    );
  }
  const signatures = signatureVerifier({
    releaseDir,
    platform,
    arch: targetArch,
    signingRequired,
  });
  const artifacts = stageArtifacts(releaseDir, stagingDir);
  assertRequiredKinds(platform, artifacts);
  const manifest = TerminalTargetEvidenceManifestSchema().parse({
    contractVersion: 1,
    kind: "terminal-target-evidence",
    generatedAt,
    commit,
    version,
    channel,
    expectedLegacy,
    target: {
      platform,
      arch: targetArch,
      runner,
      osRelease: os.release(),
      cpuCount: os.cpus().length,
      memoryBytes: String(os.totalmem()),
    },
    versions: {
      electron: terminal.runtime.electron,
      node: terminal.runtime.node,
      xterm: JSON.parse(
        readFileSync(
          requireFromWeb.resolve("@xterm/xterm/package.json"),
          "utf8",
        ),
      ).version,
      ptyHostContract: "1",
    },
    signingRequired,
    signatures,
    artifacts,
    terminal,
  });
  writeJsonAtomic(path.join(stagingDir, MANIFEST_NAME), manifest);
  return manifest;
}

function findTargetManifests(inputDir) {
  const found = [];
  for (const entry of readdirSync(inputDir, { withFileTypes: true })) {
    const candidate = entry.isDirectory()
      ? path.join(inputDir, entry.name, MANIFEST_NAME)
      : entry.name === MANIFEST_NAME
        ? path.join(inputDir, entry.name)
        : undefined;
    if (candidate && existsSync(candidate)) found.push(candidate);
  }
  return found;
}

function targetId(manifest) {
  return `${manifest.target.platform}-${manifest.target.arch}`;
}

/** Validates every staged target and writes the aggregate publication manifest. */
export function createReleaseEvidenceManifest({
  inputDir,
  outputPath = path.join(inputDir, AGGREGATE_NAME),
  channel,
  generatedAt = new Date().toISOString(),
}) {
  const resolvedOutputPath = path.resolve(outputPath);
  const manifestPaths = findTargetManifests(inputDir);
  if (manifestPaths.length === 0)
    throw new Error("No target evidence manifests were staged");
  const parsed = manifestPaths.map((manifestPath) => ({
    manifestPath,
    manifest: TerminalTargetEvidenceManifestSchema().parse(
      JSON.parse(readFileSync(manifestPath, "utf8")),
    ),
  }));
  const first = parsed[0].manifest;
  validateTargetReleaseManifests(parsed, first, channel);
  const ids = parsed.map(({ manifest }) => targetId(manifest));
  assertReleaseTargetCoverage(ids);
  const aggregate = TerminalReleaseEvidenceManifestSchema().parse({
    contractVersion: 1,
    kind: "terminal-release-evidence",
    generatedAt,
    commit: first.commit,
    version: first.version,
    channel,
    expectedLegacy: first.expectedLegacy,
    signingRequired: first.signingRequired,
    nativeDependencies: first.terminal.dependencies,
    targets: parsed
      .map(({ manifestPath, manifest }) => ({
        targetId: targetId(manifest),
        path: path.relative(inputDir, manifestPath).replaceAll(path.sep, "/"),
        sha256: sha256File(manifestPath),
        artifactCount: manifest.artifacts.length,
      }))
      .sort((left, right) => left.targetId.localeCompare(right.targetId)),
    artifacts: readdirSync(inputDir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          artifactKind(entry.name) &&
          path.resolve(inputDir, entry.name) !== resolvedOutputPath,
      )
      .map((entry) => {
        const artifactPath = path.join(inputDir, entry.name);
        return {
          name: entry.name,
          kind: artifactKind(entry.name),
          bytes: statSync(artifactPath).size,
          sha256: sha256File(artifactPath),
        };
      }),
  });
  writeJsonAtomic(resolvedOutputPath, aggregate);
  return aggregate;
}

function validateTargetReleaseManifests(parsed, first, channel) {
  for (const { manifestPath, manifest } of parsed) {
    assertMatchingTargetManifest(manifestPath, manifest, first, channel);
    assertTargetArtifactHashes(manifestPath, manifest.artifacts);
    assertMatchingNativeDependencies(manifest, first);
  }
}

function assertMatchingTargetManifest(manifestPath, manifest, first, channel) {
  const matches = manifest.channel === channel
    && manifest.commit === first.commit
    && manifest.version === first.version
    && manifest.expectedLegacy === first.expectedLegacy
    && manifest.signingRequired === first.signingRequired;
  if (!matches) throw new Error(`Target manifest does not match the aggregate release: ${manifestPath}`);
}

function assertTargetArtifactHashes(manifestPath, artifacts) {
  for (const artifact of artifacts) {
    const artifactPath = path.join(path.dirname(manifestPath), artifact.name);
    if (!existsSync(artifactPath) || sha256File(artifactPath) !== artifact.sha256) {
      throw new Error(`Staged artifact hash mismatch: ${artifactPath}`);
    }
  }
}

function assertMatchingNativeDependencies(manifest, first) {
  if (manifest.terminal.dependencies["node-pty"] !== first.terminal.dependencies["node-pty"]
    || manifest.terminal.dependencies.koffi !== first.terminal.dependencies.koffi) {
    throw new Error("Native dependency versions differ across release targets");
  }
}

function assertReleaseTargetCoverage(ids) {
  const duplicateId = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicateId) throw new Error(`Duplicate release target: ${duplicateId}`);
  for (const expected of COMPLETE_TARGETS) {
    if (!ids.includes(expected)) throw new Error(`Release target is missing: ${expected}`);
  }
}

function parseCli(argv) {
  const [command, ...rest] = argv;
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    if (!key?.startsWith("--") || rest[index + 1] === undefined)
      throw new Error(`Invalid argument: ${key ?? "<missing>"}`);
    values[key.slice(2)] = rest[index + 1];
  }
  return { command, values };
}

function required(values, key) {
  const value = values[key];
  if (!value) throw new Error(`--${key} is required`);
  return value;
}

function requiredBoolean(values, key) {
  const value = required(values, key);
  if (value !== "true" && value !== "false")
    throw new Error(`--${key} must be true or false`);
  return value === "true";
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  const { command, values } = parseCli(process.argv.slice(2));
  if (command === "target") {
    createTargetEvidenceManifest({
      releaseDir: required(values, "release-dir"),
      stagingDir: required(values, "staging-dir"),
      attestationPath: values.attestation,
      commit: required(values, "commit"),
      version: required(values, "version"),
      channel: required(values, "channel"),
      expectedLegacy: requiredBoolean(values, "expected-legacy"),
      targetPlatform: required(values, "platform"),
      targetArch: required(values, "arch"),
      runner: required(values, "runner"),
      signingRequired: requiredBoolean(values, "signing-required"),
    });
  } else if (command === "aggregate") {
    createReleaseEvidenceManifest({
      inputDir: required(values, "input-dir"),
      outputPath: values.output,
      channel: required(values, "channel"),
    });
  } else {
    throw new Error(
      `Unsupported terminal release evidence command: ${command ?? "<missing>"}`,
    );
  }
}
