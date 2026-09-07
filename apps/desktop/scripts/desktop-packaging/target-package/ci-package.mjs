/**
 * CI-only helper that prepares the desktop package and invokes electron-builder.
 */

import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { sanitizePackageManifest } from "./sanitize-package-manifest.mjs";

const MAX_ATTEMPTS = 3;
const DEFAULT_DIAGNOSTIC_LIMIT_BYTES = 64 * 1024;
const ELECTRON_RELEASE_URL = /https?:\/\/[^\s"']*electron[^\s"']*\/releases\/download\//i;
const TRANSIENT_DOWNLOAD_FAILURE = /\b(?:EOF|ECONNRESET|ETIMEDOUT|temporary connection failure)\b/i;

/** Resolves the Bun executable before CI removes Bun's bin directory from PATH. */
export function resolveBunExecutable(env = process.env, platform = process.platform) {
  if (env.BUN && NodeFS.existsSync(env.BUN)) return env.BUN;
  const command = platform === "win32" ? "where.exe" : "which";
  const output = NodeChildProcess.execFileSync(command, ["bun"], {
    encoding: "utf8",
    env,
  });
  const executable = output.split(/\r?\n/).find((candidate) => NodeFS.existsSync(candidate));
  if (!executable) throw new Error("[ci-package] Bun executable not found");
  return executable;
}

/** Classifies only known transient Electron release download failures. */
export function classifyElectronBuilderFailure(
  output,
  { electronReleaseDownload, transientError } = {},
) {
  const text = String(output ?? "");
  if (!(electronReleaseDownload ?? ELECTRON_RELEASE_URL.test(text))) {
    return { retryable: false, reason: "not-electron-release-download" };
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
  assertRunAttempt(runAttempt);
  const attemptLimit = boundedAttemptLimit(maxAttempts);
  return runElectronBuilderAttempts(runAttempt, attemptLimit, diagnosticLimitBytes);
}

function assertRunAttempt(runAttempt) {
  if (typeof runAttempt !== "function") throw new TypeError("runAttempt must be a function");
}

function boundedAttemptLimit(maxAttempts) {
  return Math.min(Math.max(Number(maxAttempts) || MAX_ATTEMPTS, 1), MAX_ATTEMPTS);
}

async function runElectronBuilderAttempts(runAttempt, attemptLimit, diagnosticLimitBytes) {
  let lastResult;
  for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
    lastResult = await runAttempt(attempt);
    if (lastResult?.status === 0) return lastResult;
    if (shouldStopElectronBuilderRetries(lastResult, attempt, attemptLimit)) {
      throw electronBuilderAttemptFailure(lastResult, attempt, attemptLimit, diagnosticLimitBytes);
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

function shouldStopElectronBuilderRetries(result, attempt, attemptLimit) {
  const output = String(result?.output ?? "");
  const classification = result?.classification ?? classifyElectronBuilderFailure(output);
  return !classification.retryable || attempt === attemptLimit;
}

function electronBuilderAttemptFailure(result, attempts, attemptLimit, diagnosticLimitBytes) {
  return packageFailure({
    status: result?.status ?? 1,
    diagnostics: boundedTail(result?.output, diagnosticLimitBytes),
    attempts,
    attemptLimit,
  });
}

function findElectronBuilderCli(desktopRoot) {
  const candidates = [
    NodePath.resolve(desktopRoot, "node_modules/electron-builder/out/cli/cli.js"),
    NodePath.resolve(desktopRoot, "../../node_modules/electron-builder/out/cli/cli.js"),
  ];
  for (const candidate of candidates) {
    if (NodeFS.existsSync(candidate)) return candidate;
  }
  const bunDir = NodePath.resolve(desktopRoot, "../../node_modules/.bun");
  if (NodeFS.existsSync(bunDir)) {
    for (const entry of NodeFS.readdirSync(bunDir)) {
      if (!entry.startsWith("electron-builder@")) continue;
      const candidate = NodePath.resolve(
        bunDir,
        entry,
        "node_modules/electron-builder/out/cli/cli.js",
      );
      if (NodeFS.existsSync(candidate)) return candidate;
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
    const child = NodeChildProcess.spawn(nodeExecutable, args, {
      cwd,
      env,
      stdio: ["inherit", "pipe", "pipe"],
      windowsHide: true,
    });
    let diagnostics = "";
    let classificationWindow = "";
    let sawElectronReleaseDownload = false;
    let sawTransientError = false;
    let settled = false;
    const consume = (chunk) => {
      const text = chunk.toString();
      process.stdout.write(text);
      diagnostics = boundedTail(`${diagnostics}${text}`, diagnosticLimitBytes);
      classificationWindow = boundedTail(`${classificationWindow}${text}`, 4096);
      sawElectronReleaseDownload ||= ELECTRON_RELEASE_URL.test(classificationWindow);
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
          electronReleaseDownload: sawElectronReleaseDownload,
          transientError: sawTransientError,
        }),
      });
    });
  });
}

async function packageDesktop() {
  const scriptRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..", "..", "..");
  const pkgPath = NodePath.resolve(scriptRoot, "package.json");
  const pkg = sanitizePackageManifest(JSON.parse(NodeFS.readFileSync(pkgPath, "utf8")));
  NodeFS.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log("[ci-package] Stripped workspace:* entries from package.json dependency fields");

  NodeFS.writeFileSync(
    NodePath.resolve(scriptRoot, "package-lock.json"),
    `${JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: {} }, null, 2)}\n`,
  );
  console.log("[ci-package] Created minimal package-lock.json");

  const rootPackagePath = NodePath.resolve(scriptRoot, "..", "..", "package.json");
  const rootPackage = JSON.parse(NodeFS.readFileSync(rootPackagePath, "utf8"));
  delete rootPackage.workspaces;
  NodeFS.writeFileSync(rootPackagePath, `${JSON.stringify(rootPackage, null, 2)}\n`);
  console.log("[ci-package] Stripped workspaces from root package.json");

  const bunExecutable = resolveBunExecutable();
  const separator = process.platform === "win32" ? ";" : ":";
  const filteredPath = (process.env.PATH ?? "")
    .split(separator)
    .filter((entry) => !entry.includes(".bun"))
    .join(separator);
  console.log("[ci-package] Installing native dependencies with npm...");
  const npmResult = NodeChildProcess.spawnSync("npm", ["install", "--no-audit", "--no-fund"], {
    cwd: scriptRoot,
    stdio: "inherit",
    env: { ...process.env, PATH: filteredPath },
    windowsHide: true,
  });
  if (npmResult.status !== 0) throw new Error("[ci-package] npm install failed");

  const electronBuilderCli = findElectronBuilderCli(scriptRoot);
  const nodeExecutable = process.platform === "win32" ? "node.exe" : "node";
  const args = [electronBuilderCli, "--publish", "never", ...process.argv.slice(2)];
  const result = await runElectronBuilderWithRetry({
    runAttempt: () =>
      runElectronBuilderAttempt({
        nodeExecutable,
        args,
        cwd: scriptRoot,
        env: { ...process.env, PATH: filteredPath, BUN: bunExecutable },
        diagnosticLimitBytes: DEFAULT_DIAGNOSTIC_LIMIT_BYTES,
      }),
  });
  return result;
}

if (process.argv[1] && NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)) {
  await packageDesktop();
}
