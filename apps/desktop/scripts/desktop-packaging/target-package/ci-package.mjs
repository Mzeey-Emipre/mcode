/**
 * CI-only helper that prepares the desktop package and invokes electron-builder.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizePackageManifest } from "./sanitize-package-manifest.mjs";

const MAX_ATTEMPTS = 3;
const DEFAULT_DIAGNOSTIC_LIMIT_BYTES = 64 * 1024;
const DARWIN_NODE_PTY_VERSION = "1.1.0";
const PATCH_COMMAND_DIAGNOSTIC_LIMIT_BYTES = 4 * 1024;
const ELECTRON_DOWNLOAD_URL = /(?:https:\/\/github\.com\/electron\/electron\/releases\/download\/|https:\/\/(?:www\.)?electronjs\.org\/headers\/v\d+(?:\.\d+){2}\/node-v\d+(?:\.\d+){2}-headers\.tar\.gz\b)/i;
const TRANSIENT_DOWNLOAD_FAILURE = /\b(?:EOF|ECONNRESET|ETIMEDOUT|temporary connection failure)\b/i;

/** Classifies only known transient Electron download failures. */
export function classifyElectronBuilderFailure(
  output,
  { electronDownload, transientError } = {},
) {
  const text = String(output ?? "");
  if (!(electronDownload ?? ELECTRON_DOWNLOAD_URL.test(text))) {
    return { retryable: false, reason: "not-electron-download" };
  }
  if (!(transientError ?? TRANSIENT_DOWNLOAD_FAILURE.test(text))) {
    return { retryable: false, reason: "not-transient-download-failure" };
  }
  return { retryable: true, reason: "transient-electron-download-failure" };
}

function boundedTail(value, limitBytes) {
  const text = String(value ?? "");
  if (Buffer.byteLength(text) <= limitBytes) return text;
  const bytes = Buffer.from(text);
  return bytes.subarray(bytes.length - limitBytes).toString("utf8");
}

function patchCommandDiagnostics(result) {
  const output = [result?.error?.message ?? result?.error, result?.stderr, result?.stdout]
    .filter((value) => value != null)
    .map((value) => String(value))
    .join("\n");
  return boundedTail(output, PATCH_COMMAND_DIAGNOSTIC_LIMIT_BYTES);
}

function assertPatchCommandSucceeded(result, stage) {
  if (result?.status === 0 && !result.error && !result.signal) return;
  const diagnostics = patchCommandDiagnostics(result);
  const suffix = diagnostics ? `: ${diagnostics}` : "";
  throw new Error(
    `[ci-package] git apply ${stage} failed with status ${result?.status ?? "unknown"}${suffix}`,
  );
}

/**
 * Applies the pinned Darwin node-pty source patch after npm has installed the target package.
 *
 * @param {{
 *   desktopRoot: string,
 *   hostPlatform?: NodeJS.Platform,
 *   repoRoot?: string,
 *   runCommand?: (command: string, args: string[], options: object) => object,
 * }} options
 * @returns {{ applied: boolean, packageRoot?: string, patchPath?: string }}
 */
export function prepareDarwinNodePtySource({
  desktopRoot,
  hostPlatform = process.platform,
  repoRoot = resolve(desktopRoot, "..", ".."),
  runCommand = (command, args, options) => spawnSync(command, args, options),
}) {
  if (hostPlatform !== "darwin") return { applied: false };

  const packageRoot = resolve(desktopRoot, "node_modules", "node-pty");
  const packageManifest = JSON.parse(
    readFileSync(resolve(packageRoot, "package.json"), "utf8"),
  );
  if (packageManifest.version !== DARWIN_NODE_PTY_VERSION) {
    throw new Error(
      `[ci-package] Darwin node-pty package must be exactly ${DARWIN_NODE_PTY_VERSION}`,
    );
  }

  const patchPath = resolve(repoRoot, "patches", "node-pty@1.1.0.patch");
  if (!existsSync(patchPath)) {
    throw new Error("[ci-package] Darwin node-pty source patch is missing");
  }
  const commandOptions = {
    cwd: packageRoot,
    encoding: "utf8",
    maxBuffer: PATCH_COMMAND_DIAGNOSTIC_LIMIT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    windowsHide: true,
  };
  assertPatchCommandSucceeded(
    runCommand("git", ["apply", "--check", patchPath], commandOptions),
    "check",
  );
  assertPatchCommandSucceeded(
    runCommand("git", ["apply", patchPath], commandOptions),
    "apply",
  );
  return { applied: true, packageRoot, patchPath };
}

/** Builds the electron-builder command line for the current packaging host. */
export function buildElectronBuilderArgs({
  electronBuilderCli,
  buildArgs = [],
  hostPlatform = process.platform,
}) {
  const args = [electronBuilderCli, "--publish", "never", ...buildArgs];
  if (hostPlatform === "darwin") {
    args.push("--config.buildDependenciesFromSource=true");
  }
  return args;
}

function packageFailure({ status, diagnostics, attempts, attemptLimit }) {
  const error = new Error(
    `[ci-package] electron-builder failed on attempt ${attempts}/${attemptLimit}`,
  );
  error.status = status;
  error.attempts = attempts;
  error.diagnostics = diagnostics;
  return error;
}

/** Runs electron-builder with a bounded retry for classified download failures. */
export async function runElectronBuilderWithRetry({
  runAttempt,
  maxAttempts = MAX_ATTEMPTS,
  diagnosticLimitBytes = DEFAULT_DIAGNOSTIC_LIMIT_BYTES,
}) {
  if (typeof runAttempt !== "function") {
    throw new TypeError("runAttempt must be a function");
  }
  const attemptLimit = Math.min(Math.max(Number(maxAttempts) || MAX_ATTEMPTS, 1), MAX_ATTEMPTS);
  let lastResult;
  for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
    lastResult = await runAttempt(attempt);
    if (lastResult?.status === 0) return lastResult;
    const output = String(lastResult?.output ?? "");
    const diagnostics = boundedTail(output, diagnosticLimitBytes);
    const classification =
      lastResult?.classification ?? classifyElectronBuilderFailure(output);
    if (!classification.retryable || attempt === attemptLimit) {
      throw packageFailure({
        status: lastResult?.status ?? 1,
        diagnostics,
        attempts: attempt,
        attemptLimit,
      });
    }
    console.warn(
      `[ci-package] Retrying transient Electron download failure (${attempt + 1}/${attemptLimit})`,
    );
  }
  throw packageFailure({
    status: lastResult?.status ?? 1,
    diagnostics: boundedTail(lastResult?.output, diagnosticLimitBytes),
    attempts: attemptLimit,
    attemptLimit,
  });
}

function findElectronBuilderCli(desktopRoot) {
  const candidates = [
    resolve(desktopRoot, "node_modules/electron-builder/out/cli/cli.js"),
    resolve(desktopRoot, "../../node_modules/electron-builder/out/cli/cli.js"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  const bunDir = resolve(desktopRoot, "../../node_modules/.bun");
  if (existsSync(bunDir)) {
    for (const entry of readdirSync(bunDir)) {
      if (!entry.startsWith("electron-builder@")) continue;
      const candidate = resolve(
        bunDir,
        entry,
        "node_modules/electron-builder/out/cli/cli.js",
      );
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error("[ci-package] electron-builder CLI not found");
}

function runElectronBuilderAttempt({
  nodeExecutable,
  args,
  cwd,
  env,
  diagnosticLimitBytes,
}) {
  return new Promise((resolveAttempt) => {
    const child = spawn(nodeExecutable, args, {
      cwd,
      env,
      stdio: ["inherit", "pipe", "pipe"],
      windowsHide: true,
    });
    let diagnostics = "";
    let classificationWindow = "";
    let sawElectronDownload = false;
    let sawTransientError = false;
    let settled = false;
    const consume = (chunk) => {
      const text = chunk.toString();
      process.stdout.write(text);
      diagnostics = boundedTail(`${diagnostics}${text}`, diagnosticLimitBytes);
      classificationWindow = boundedTail(`${classificationWindow}${text}`, 4096);
      sawElectronDownload ||= ELECTRON_DOWNLOAD_URL.test(classificationWindow);
      sawTransientError ||= TRANSIENT_DOWNLOAD_FAILURE.test(classificationWindow);
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      resolveAttempt({
        status: 1,
        output: boundedTail(String(error), diagnosticLimitBytes),
        classification: { retryable: false, reason: "child-process-error" },
      });
    });
    child.on("close", (status) => {
      if (settled) return;
      settled = true;
      resolveAttempt({
        status: status ?? 1,
        output: diagnostics,
        classification: classifyElectronBuilderFailure("", {
          electronDownload: sawElectronDownload,
          transientError: sawTransientError,
        }),
      });
    });
  });
}

async function packageDesktop() {
  const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const pkgPath = resolve(scriptRoot, "package.json");
  const pkg = sanitizePackageManifest(JSON.parse(readFileSync(pkgPath, "utf8")));
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log("[ci-package] Stripped workspace:* entries from package.json dependency fields");

  writeFileSync(
    resolve(scriptRoot, "package-lock.json"),
    `${JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: {} }, null, 2)}\n`,
  );
  console.log("[ci-package] Created minimal package-lock.json");

  const rootPackagePath = resolve(scriptRoot, "..", "..", "package.json");
  const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf8"));
  delete rootPackage.workspaces;
  writeFileSync(rootPackagePath, `${JSON.stringify(rootPackage, null, 2)}\n`);
  console.log("[ci-package] Stripped workspaces from root package.json");

  const separator = process.platform === "win32" ? ";" : ":";
  const filteredPath = (process.env.PATH ?? "")
    .split(separator)
    .filter((entry) => !entry.includes(".bun"))
    .join(separator);
  console.log("[ci-package] Installing native dependencies with npm...");
  const npmResult = spawnSync("npm", ["install", "--no-audit", "--no-fund"], {
    cwd: scriptRoot,
    stdio: "inherit",
    env: { ...process.env, PATH: filteredPath },
    windowsHide: true,
  });
  if (npmResult.status !== 0) throw new Error("[ci-package] npm install failed");

  prepareDarwinNodePtySource({ desktopRoot: scriptRoot });

  const electronBuilderCli = findElectronBuilderCli(scriptRoot);
  const nodeExecutable = process.platform === "win32" ? "node.exe" : "node";
  const args = buildElectronBuilderArgs({
    electronBuilderCli,
    buildArgs: process.argv.slice(2),
  });
  const result = await runElectronBuilderWithRetry({
    runAttempt: () =>
      runElectronBuilderAttempt({
        nodeExecutable,
        args,
        cwd: scriptRoot,
        env: { ...process.env, PATH: filteredPath },
        diagnosticLimitBytes: DEFAULT_DIAGNOSTIC_LIMIT_BYTES,
      }),
  });
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await packageDesktop();
}
