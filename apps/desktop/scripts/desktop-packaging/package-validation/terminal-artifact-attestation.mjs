import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { getPackagedRuntimeStartupTimeoutMs } from "./smoke-test-config.mjs";

/** Maximum compressed Terminal-specific package delta allowed per target. */
export const TERMINAL_ARTIFACT_MAX_COMPRESSED_BYTES = 10 * 1024 * 1024;

const TARGET_ARCHES = new Set(["x64", "arm64"]);
const TARGET_PLATFORMS = new Set(["win32", "darwin", "linux"]);
const EXPECTED_NATIVE_PACKAGES = ["node-pty", "koffi"];
const MAX_TERMINAL_PACKAGE_FILES = 10_000;
const MAX_TERMINAL_PACKAGE_DIRECTORIES = 512;
const MAX_TERMINAL_PACKAGE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TERMINAL_PACKAGE_BYTES = 128 * 1024 * 1024;
const NATIVE_RUNTIME_EXTENSIONS = new Set([".dll", ".exe", ".node"]);
const PRUNABLE_NATIVE_EXTENSIONS = new Set([
  ...NATIVE_RUNTIME_EXTENSIONS,
  ".pdb",
]);

function requireFile(filePath, label) {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    throw new Error(`${label} is missing at ${filePath}`);
  }
  return realpathSync(filePath);
}

function requireDirectory(directoryPath, label) {
  if (!existsSync(directoryPath) || !statSync(directoryPath).isDirectory()) {
    throw new Error(`${label} is missing at ${directoryPath}`);
  }
  return realpathSync(directoryPath);
}

function assertExecutableFile(filePath, label) {
  const stats = lstatSync(filePath);
  if (!stats.isFile()) {
    throw new Error(`${label} is not a regular file at ${filePath}`);
  }
  if ((stats.mode & 0o111) === 0) {
    throw new Error(`${label} is not executable at ${filePath}`);
  }
}

function ensureExecutableFile(filePath, label) {
  const stats = lstatSync(filePath);
  if (!stats.isFile()) {
    throw new Error(`${label} is not a regular file at ${filePath}`);
  }
  chmodSync(filePath, 0o755);
  assertExecutableFile(filePath, label);
}

function relativeArtifactPath(resourcesRoot, artifactPath) {
  const relative = path.relative(resourcesRoot, artifactPath);
  if (
    relative === "" ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `Terminal artifact escapes the packaged resources root: ${artifactPath}`,
    );
  }
  return relative.replaceAll("\\", "/");
}

function addFileToBudget(filePath, budget) {
  const bytes = lstatSync(filePath).size;
  if (bytes > MAX_TERMINAL_PACKAGE_FILE_BYTES) {
    throw new Error(
      `Terminal package file exceeds ${MAX_TERMINAL_PACKAGE_FILE_BYTES} bytes: ${filePath}`,
    );
  }
  budget.files += 1;
  budget.bytes += bytes;
  if (budget.files > MAX_TERMINAL_PACKAGE_FILES) {
    throw new Error(
      `Terminal package exceeds ${MAX_TERMINAL_PACKAGE_FILES} files`,
    );
  }
  if (budget.bytes > MAX_TERMINAL_PACKAGE_BYTES) {
    throw new Error(
      `Terminal package exceeds ${MAX_TERMINAL_PACKAGE_BYTES} uncompressed bytes`,
    );
  }
}

function readBoundedFile(filePath) {
  const bytes = lstatSync(filePath).size;
  if (bytes > MAX_TERMINAL_PACKAGE_FILE_BYTES) {
    throw new Error(
      `Terminal package file exceeds ${MAX_TERMINAL_PACKAGE_FILE_BYTES} bytes: ${filePath}`,
    );
  }
  return readFileSync(filePath);
}

function readPackageVersion(packageRoot, packageName) {
  const packageJsonPath = requireFile(
    path.join(packageRoot, "package.json"),
    `${packageName} package manifest`,
  );
  const value = JSON.parse(readBoundedFile(packageJsonPath).toString("utf8"));
  if (
    value?.name !== packageName ||
    typeof value.version !== "string" ||
    value.version.length === 0
  ) {
    throw new Error(
      `Packaged ${packageName} manifest has an invalid name or version`,
    );
  }
  return value.version;
}

function listFiles(root, budget = { files: 0, bytes: 0 }) {
  const files = [];
  const pending = [root];
  budget.directories ??= 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    budget.directories += 1;
    if (budget.directories > MAX_TERMINAL_PACKAGE_DIRECTORIES) {
      throw new Error(
        `Terminal package exceeds ${MAX_TERMINAL_PACKAGE_DIRECTORIES} directories`,
      );
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Terminal package contains a symbolic link: ${entryPath}`);
      }
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile()) {
        addFileToBudget(entryPath, budget);
        files.push(entryPath);
      } else if (!lstatSync(entryPath).isFile()) {
        throw new Error(`Terminal package contains an unsupported entry: ${entryPath}`);
      }
    }
  }
  return files;
}

function isNativeRuntimeFile(filePath) {
  return (
    NATIVE_RUNTIME_EXTENSIONS.has(path.extname(filePath).toLowerCase()) ||
    path.basename(filePath) === "spawn-helper"
  );
}

function isPrunableNativeFile(filePath) {
  return (
    PRUNABLE_NATIVE_EXTENSIONS.has(path.extname(filePath).toLowerCase()) ||
    path.basename(filePath) === "spawn-helper"
  );
}

function artifactPathKey(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function selectNodePtyBinding(nodePtyRoot, targetPlatform, targetArch) {
  const bindingName = targetPlatform === "win32" ? "conpty.node" : "pty.node";
  const candidates = [
    path.join(nodePtyRoot, "build", "Release", bindingName),
    path.join(
      nodePtyRoot,
      "prebuilds",
      `${targetPlatform}-${targetArch}`,
      bindingName,
    ),
  ];
  const existing = candidates.filter((candidate) => existsSync(candidate));
  const selected = existing.find(
    (candidate) => detectNativeArchitecture(candidate) === targetArch,
  );
  if (!selected) {
    const found = existing.map(
      (candidate) => `${candidate} (${detectNativeArchitecture(candidate) ?? "unknown"})`,
    );
    throw new Error(
      `Packaged node-pty ${targetArch} binding is missing from ${candidates.join(" or ")}; found: ${found.join(", ") || "none"}`,
    );
  }
  return selected;
}

function expectedNativePaths(packageRoots, targetPlatform, targetArch) {
  const nodePtyBinding = selectNodePtyBinding(
    packageRoots["node-pty"],
    targetPlatform,
    targetArch,
  );
  const koffiBinding = path.join(
    packageRoots.koffi,
    "build",
    "koffi",
    `${targetPlatform}_${targetArch}`,
    "koffi.node",
  );
  const nodePtyRuntime = nodePtyRuntimePaths(
    nodePtyBinding,
    targetPlatform,
  );
  return { nodePtyBinding, koffiBinding, nodePtyRuntime };
}

function nodePtyRuntimePaths(nodePtyBinding, targetPlatform) {
  if (targetPlatform === "win32") {
    return [
      path.join(path.dirname(nodePtyBinding), "conpty", "conpty.dll"),
      path.join(path.dirname(nodePtyBinding), "conpty", "OpenConsole.exe"),
    ];
  }
  if (targetPlatform === "darwin") {
    return [path.join(path.dirname(nodePtyBinding), "spawn-helper")];
  }
  return [];
}

function removeNodeGypToolArtifacts(nodePtyRoot) {
  const toolDirectory = path.join(nodePtyRoot, "build", "node_gyp_bins");
  // node-gyp creates interpreter links for its build process. They are not
  // runtime inputs and must not weaken the packaged tree's no-symlink rule.
  rmSync(toolDirectory, { recursive: true, force: true });
}

/** Removes non-target native files from one unpacked Terminal package. */
export function retainTargetTerminalNativeArtifacts({
  resourcesRoot,
  targetPlatform,
  targetArch,
}) {
  if (!TARGET_PLATFORMS.has(targetPlatform) || !TARGET_ARCHES.has(targetArch)) {
    throw new Error(
      `Unsupported Terminal package target: ${targetPlatform}-${targetArch}`,
    );
  }
  const unpackedRoot = path.join(
    requireDirectory(resourcesRoot, "Packaged resources root"),
    "app.asar.unpacked",
  );
  const packageRoots = {
    "node-pty": requireDirectory(
      path.join(unpackedRoot, "node_modules/node-pty"),
      "Packaged node-pty",
    ),
    koffi: requireDirectory(
      path.join(unpackedRoot, "node_modules/koffi"),
      "Packaged koffi",
    ),
  };
  removeNodeGypToolArtifacts(packageRoots["node-pty"]);
  const expected = expectedNativePaths(
    packageRoots,
    targetPlatform,
    targetArch,
  );
  if (targetPlatform === "darwin") {
    for (const runtimePath of expected.nodePtyRuntime) {
      ensureExecutableFile(runtimePath, "macOS node-pty spawn helper");
    }
  }
  const retained = new Set(
    [expected.nodePtyBinding, expected.koffiBinding, ...expected.nodePtyRuntime].map(
      artifactPathKey,
    ),
  );
  const packageBudget = { files: 0, bytes: 0, directories: 0 };
  for (const packageRoot of Object.values(packageRoots)) {
    for (const filePath of listFiles(packageRoot, packageBudget)) {
      if (
        isPrunableNativeFile(filePath) &&
        !retained.has(artifactPathKey(filePath))
      ) {
        rmSync(filePath, { force: true });
      }
    }
  }
  return expected;
}

function detectPeArchitecture(bytes) {
  if (bytes.length < 70 || bytes.toString("ascii", 0, 2) !== "MZ")
    return undefined;
  const peOffset = bytes.readUInt32LE(0x3c);
  if (
    peOffset + 6 > bytes.length ||
    bytes.toString("binary", peOffset, peOffset + 4) !== "PE\0\0"
  ) {
    throw new Error("Native Windows artifact has an invalid PE header");
  }
  const machine = bytes.readUInt16LE(peOffset + 4);
  if (machine === 0x8664) return "x64";
  if (machine === 0xaa64) return "arm64";
  throw new Error(
    `Native Windows artifact uses unsupported PE machine 0x${machine.toString(16)}`,
  );
}

function detectElfArchitecture(bytes) {
  if (
    bytes.length < 20 ||
    !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
  ) {
    return undefined;
  }
  const littleEndian = bytes[5] === 1;
  if (!littleEndian && bytes[5] !== 2)
    throw new Error("Native Linux artifact has an invalid ELF byte order");
  const machine = littleEndian
    ? bytes.readUInt16LE(18)
    : bytes.readUInt16BE(18);
  if (machine === 62) return "x64";
  if (machine === 183) return "arm64";
  throw new Error(
    `Native Linux artifact uses unsupported ELF machine ${machine}`,
  );
}

function detectMachOArchitecture(bytes) {
  if (bytes.length < 8) return undefined;
  const magic = bytes.readUInt32BE(0);
  let cpuType;
  if (magic === 0xfeedfacf) cpuType = bytes.readUInt32BE(4);
  else if (magic === 0xcffaedfe) cpuType = bytes.readUInt32LE(4);
  else return undefined;
  if (cpuType === 0x01000007) return "x64";
  if (cpuType === 0x0100000c) return "arm64";
  throw new Error(
    `Native macOS artifact uses unsupported CPU type 0x${cpuType.toString(16)}`,
  );
}

/** Returns the architecture encoded in a PE, ELF, or 64-bit Mach-O artifact. */
export function detectNativeArchitecture(filePath) {
  const bytes = readBoundedFile(filePath);
  const architecture =
    detectPeArchitecture(bytes) ??
    detectElfArchitecture(bytes) ??
    detectMachOArchitecture(bytes);
  if (!architecture)
    throw new Error(
      `Native artifact has an unsupported executable format: ${filePath}`,
    );
  return architecture;
}

function attestFile(
  resourcesRoot,
  kind,
  filePath,
  { expectedArch, modulesAbi, origin },
) {
  const resolvedPath = requireFile(filePath, `${kind} artifact`);
  let architecture;
  if (expectedArch) {
    architecture = detectNativeArchitecture(resolvedPath);
    if (architecture !== expectedArch) {
      throw new Error(
        `Native artifact architecture mismatch for ${resolvedPath}: expected ${expectedArch}, found ${architecture}`,
      );
    }
  }
  const bytes = readBoundedFile(resolvedPath);
  return {
    kind,
    path: relativeArtifactPath(resourcesRoot, resolvedPath),
    origin,
    ...(architecture ? { architecture, modulesAbi } : {}),
    bytes: bytes.byteLength,
    compressedBytes: gzipSync(bytes, { level: 9 }).byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function nativeOrigin(packageName, version, filePath) {
  if (packageName === "koffi") {
    return `${packageName}@${version}:locked-package-artifact`;
  }
  const source = filePath.split(path.sep).includes("prebuilds")
    ? "upstream-prebuild"
    : "target-rebuild";
  return `${packageName}@${version}:${source}`;
}

function assertNativeInventory(packageRoots, expectedPaths) {
  const actual = Object.values(packageRoots).flatMap((packageRoot) =>
    listFiles(packageRoot).filter(isNativeRuntimeFile),
  );
  const expected = new Set(expectedPaths.map(artifactPathKey));
  const extras = actual.filter((filePath) => !expected.has(artifactPathKey(filePath)));
  const missing = expectedPaths.filter((filePath) => !existsSync(filePath));
  if (extras.length > 0 || missing.length > 0 || actual.length !== expected.size) {
    throw new Error(
      `Packaged Terminal native inventory mismatch; unexpected or duplicate: ${extras.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}`,
    );
  }
}

function measureCompressedDelta(files) {
  const uniqueFiles = new Map(
    files.map((filePath) => [artifactPathKey(realpathSync(filePath)), filePath]),
  );
  return [...uniqueFiles.values()].reduce(
    (total, filePath) =>
      total + gzipSync(readBoundedFile(filePath), { level: 9 }).byteLength,
    0,
  );
}

/** Parses bounded runtime evidence while preserving useful process diagnostics. */
export function parseLoadProbeProcessResult(result) {
  if (result.error) {
    throw new Error(`Packaged runtime load probe failed: ${result.error.message}`);
  }
  const output = typeof result.stdout === "string" ? result.stdout.trim() : "";
  if (output.length > 0) {
    try {
      return JSON.parse(output);
    } catch (error) {
      throw new Error(
        `Packaged runtime load probe emitted invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const processFailure = result.signal
    ? `signal ${result.signal}`
    : `status ${result.status ?? "unknown"}`;
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  throw new Error(
    `Packaged runtime load probe emitted no evidence after ${processFailure}${stderr ? `: ${stderr}` : ""}`,
  );
}

function defaultLoadProbe({
  runtimePath,
  hostBundlePath,
  nodePtyRoot,
  koffiRoot,
  startupTimeoutMs,
}) {
  const probe = String.raw`
    const { fork } = require('node:child_process');
    const path = require('node:path');
    const roots = [process.env.MCODE_NODE_PTY_ROOT, process.env.MCODE_KOFFI_ROOT];
    const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
    const host = fork(process.env.MCODE_PTY_HOST_BUNDLE, [], {
      execPath: process.execPath,
      env: process.env,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let hostReady = false;
    let stderr = '';
    host.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-8192);
    });
    const timer = setTimeout(() => {
      host.kill('SIGKILL');
      process.stderr.write('Packaged PTY host startup timed out\n' + stderr);
      process.exit(1);
    }, ${startupTimeoutMs});
    host.on('error', (error) => {
      clearTimeout(timer);
      throw error;
    });
    host.on('message', (message) => {
      if (message && message.kind === 'ready') {
        hostReady = true;
        host.send({
          contractVersion: 1,
          kind: 'shutdown',
          hostGeneration: '1',
          reason: 'app-shutdown',
        });
      }
    });
    host.on('exit', () => {
      clearTimeout(timer);
      if (!hostReady) {
        process.stderr.write('Packaged PTY host failed startup\n' + stderr);
        process.exitCode = 1;
        return;
      }
      const before = new Set(Object.keys(require.cache));
      const nodePtyUtils = require(path.join(roots[0], 'lib', 'utils.js'));
      nodePtyUtils.loadNativeModule(process.platform === 'win32' ? 'conpty' : 'pty');
      require(roots[1]);
      const nativeModules = Object.keys(require.cache)
        .filter((entry) => !before.has(entry) && entry.endsWith('.node'))
        .map((entry) => ({
          packageName: entry.startsWith(roots[0]) ? 'node-pty' : entry.startsWith(roots[1]) ? 'koffi' : 'unknown',
          path: entry,
        }));
      const result = JSON.stringify({
        platform: process.platform,
        arch: process.arch,
        modulesAbi: process.versions.modules,
        nodeVersion: process.versions.node,
        electronVersion: process.versions.electron,
        hostReady,
        nativeModules,
      });
      process.stdout.write(result, () => process.exit(0));
    });
    host.send({
      contractVersion: 1,
      kind: 'handshake',
      requestedGeneration: '1',
      platform,
    });
  `;
  const result = spawnSync(runtimePath, ["-e", probe], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      MCODE_PTY_HOST_BUNDLE: hostBundlePath,
      MCODE_NODE_PTY_ROOT: nodePtyRoot,
      MCODE_KOFFI_ROOT: koffiRoot,
    },
    encoding: "utf8",
    timeout: startupTimeoutMs + 5_000,
    maxBuffer: 64 * 1024,
  });
  return parseLoadProbeProcessResult(result);
}

function validateLoadProbe(probe, targetPlatform, targetArch, packageRoots) {
  if (probe?.platform !== targetPlatform || probe?.arch !== targetArch) {
    throw new Error(
      `Packaged runtime target mismatch: expected ${targetPlatform}-${targetArch}, found ${probe?.platform}-${probe?.arch}`,
    );
  }
  if (typeof probe.modulesAbi !== "string" || !/^\d+$/.test(probe.modulesAbi)) {
    throw new Error("Packaged runtime did not report a valid Node modules ABI");
  }
  if (
    typeof probe.nodeVersion !== "string" ||
    !/^\d+\.\d+\.\d+/.test(probe.nodeVersion)
  ) {
    throw new Error("Packaged runtime did not report its Node version");
  }
  if (
    typeof probe.electronVersion !== "string" ||
    !/^\d+\.\d+\.\d+/.test(probe.electronVersion)
  ) {
    throw new Error("Packaged runtime did not report its Electron version");
  }
  if (probe.hostReady !== true) {
    throw new Error("Packaged runtime did not start the PTY host bundle");
  }
  if (!Array.isArray(probe.nativeModules)) {
    throw new Error("Packaged runtime did not report loaded native modules");
  }
  const nativeByPackage = new Map();
  for (const entry of probe.nativeModules) {
    if (
      !EXPECTED_NATIVE_PACKAGES.includes(entry?.packageName) ||
      typeof entry.path !== "string"
    ) {
      throw new Error("Packaged runtime reported an unexpected native module");
    }
    if (nativeByPackage.has(entry.packageName)) {
      throw new Error(
        `Packaged runtime loaded duplicate ${entry.packageName} native modules`,
      );
    }
    const resolvedPath = requireFile(
      entry.path,
      `${entry.packageName} loaded native module`,
    );
    const relative = path.relative(
      realpathSync(packageRoots[entry.packageName]),
      resolvedPath,
    );
    if (
      relative === "" ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(
        `Loaded ${entry.packageName} native module is outside its packaged directory`,
      );
    }
    nativeByPackage.set(entry.packageName, resolvedPath);
  }
  for (const packageName of EXPECTED_NATIVE_PACKAGES) {
    if (!nativeByPackage.has(packageName)) {
      throw new Error(
        `Packaged runtime did not load a ${packageName} native module`,
      );
    }
  }
  return {
    modulesAbi: probe.modulesAbi,
    nodeVersion: probe.nodeVersion,
    electronVersion: probe.electronVersion,
    nativeByPackage,
  };
}

/**
 * Verifies and describes the PTY host artifacts in one unpacked target package.
 * The returned data is an input for the release manifests added by the next ticket.
 */
export function attestPackagedTerminalArtifacts({
  resourcesRoot,
  runtimePath,
  hostPlatform = process.platform,
  hostArch = process.arch,
  targetPlatform,
  targetArch,
  maxCompressedBytes = TERMINAL_ARTIFACT_MAX_COMPRESSED_BYTES,
  runLoadProbe = defaultLoadProbe,
}) {
  if (!TARGET_PLATFORMS.has(targetPlatform) || !TARGET_ARCHES.has(targetArch)) {
    throw new Error(
      `Unsupported Terminal package target: ${targetPlatform}-${targetArch}`,
    );
  }
  const resolvedResourcesRoot = requireDirectory(
    resourcesRoot,
    "Packaged resources root",
  );
  const resolvedRuntimePath = requireFile(
    runtimePath,
    "Packaged mcode-server runtime",
  );
  const unpackedRoot = path.join(resolvedResourcesRoot, "app.asar.unpacked");
  const hostBundlePath = requireFile(
    path.join(unpackedRoot, "dist/server/pty-host.cjs"),
    "Packaged PTY host bundle",
  );
  const packageRoots = {
    "node-pty": requireDirectory(
      path.join(unpackedRoot, "node_modules/node-pty"),
      "Packaged node-pty",
    ),
    koffi: requireDirectory(
      path.join(unpackedRoot, "node_modules/koffi"),
      "Packaged koffi",
    ),
  };
  const dependencies = {
    "node-pty": readPackageVersion(packageRoots["node-pty"], "node-pty"),
    koffi: readPackageVersion(packageRoots.koffi, "koffi"),
  };
  const probe = runLoadProbe({
    runtimePath: resolvedRuntimePath,
    hostBundlePath,
    nodePtyRoot: packageRoots["node-pty"],
    koffiRoot: packageRoots.koffi,
    startupTimeoutMs: getPackagedRuntimeStartupTimeoutMs({
      hostPlatform,
      hostArch,
      targetPlatform,
      targetArch,
    }),
  });
  const { modulesAbi, nodeVersion, electronVersion, nativeByPackage } = validateLoadProbe(
    probe,
    targetPlatform,
    targetArch,
    packageRoots,
  );
  const nodePtyRuntime = nodePtyRuntimePaths(
    nativeByPackage.get("node-pty"),
    targetPlatform,
  );
  if (targetPlatform === "darwin") {
    for (const runtimePath of nodePtyRuntime) {
      assertExecutableFile(runtimePath, "macOS node-pty spawn helper");
    }
  }
  const expectedNativePaths = [
    nativeByPackage.get("node-pty"),
    nativeByPackage.get("koffi"),
    ...nodePtyRuntime,
  ];
  assertNativeInventory(packageRoots, expectedNativePaths);
  const nodePtyOrigin = nativeOrigin(
    "node-pty",
    dependencies["node-pty"],
    nativeByPackage.get("node-pty"),
  );
  const artifacts = [
    attestFile(resolvedResourcesRoot, "pty-host", hostBundlePath, {
      origin: "mcode-source-bundle",
    }),
    attestFile(
      resolvedResourcesRoot,
      "node-pty",
      nativeByPackage.get("node-pty"),
      {
        expectedArch: targetArch,
        modulesAbi,
        origin: nodePtyOrigin,
      },
    ),
    attestFile(
      resolvedResourcesRoot,
      "koffi",
      nativeByPackage.get("koffi"),
      {
        expectedArch: targetArch,
        modulesAbi,
        origin: nativeOrigin(
          "koffi",
          dependencies.koffi,
          nativeByPackage.get("koffi"),
        ),
      },
    ),
  ];
  artifacts.push(
    ...nodePtyRuntime.map((filePath) =>
      attestFile(
        resolvedResourcesRoot,
        targetPlatform === "win32" ? "conpty-runtime" : "node-pty-runtime",
        filePath,
        {
          expectedArch: targetArch,
          modulesAbi,
          origin: nodePtyOrigin,
        },
      ),
    ),
  );
  const hostSourceMap = `${hostBundlePath}.map`;
  const packageBudget = { files: 0, bytes: 0, directories: 0 };
  addFileToBudget(hostBundlePath, packageBudget);
  if (existsSync(hostSourceMap)) addFileToBudget(hostSourceMap, packageBudget);
  const packageFiles = Object.values(packageRoots).flatMap((packageRoot) =>
    listFiles(packageRoot, packageBudget),
  );
  const compressedBytes = measureCompressedDelta([
    hostBundlePath,
    ...(existsSync(hostSourceMap) ? [hostSourceMap] : []),
    ...packageFiles,
  ]);
  if (!Number.isSafeInteger(maxCompressedBytes) || maxCompressedBytes < 1) {
    throw new Error("Terminal artifact compressed size limit is invalid");
  }
  if (compressedBytes > maxCompressedBytes) {
    throw new Error(
      `Terminal artifact compressed size ${compressedBytes} exceeds ${maxCompressedBytes} bytes`,
    );
  }
  return {
    contractVersion: 1,
    target: { platform: targetPlatform, arch: targetArch, modulesAbi },
    runtime: { node: nodeVersion, electron: electronVersion },
    dependencies,
    compressedBytes,
    compressedLimitBytes: maxCompressedBytes,
    packageFileCount:
      packageFiles.length + 1 + (existsSync(hostSourceMap) ? 1 : 0),
    artifacts,
  };
}
