import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { resolveTargetTerminalNativeArtifacts } from "./terminal-artifact-attestation.mjs";

/** Protected fault values accepted by the packaged product lane. */
export const PRODUCT_SMOKE_FAULTS = [
  "startup-health-failure",
  "post-start-host-exit",
  "containment-failure",
  "missing-native-artifact",
];

const MAX_TERMINAL_ARTIFACT_FILES = 64;
const CLEANUP_BOUND_MS = 3_000;
const LAUNCH_OUTPUT_TAIL_LIMIT = 8_192;
const PROBE_DIAGNOSTIC_LINE_LIMIT = 16;
const PROBE_DIAGNOSTIC_LINE_LENGTH = 192;
const PROBE_DIAGNOSTIC_MAX_LENGTH = 4_096;
const TARGET_PLATFORM = { win32: "windows", darwin: "macos", linux: "linux" };
const LINUX_NAMESPACE_SCRIPT =
  'set -eu; ip_cmd="$(command -v ip || command -v /sbin/ip)"; "$ip_cmd" link set lo up; "$ip_cmd" -4 addr add 127.0.0.1/8 dev lo 2>/dev/null || true; "$ip_cmd" -6 addr add ::1/128 dev lo 2>/dev/null || true; "$ip_cmd" -4 addr show dev lo | grep -q "127.0.0.1"; "$ip_cmd" -6 addr show dev lo | grep -q "::1"';
/** Restricts Darwin product launches and helper probes to loopback networking. */
export const MACOS_LOOPBACK_PROFILE =
  '(version 1) (allow default) (deny network*) (allow network-outbound (remote ip "localhost:*")) (allow network-inbound (local ip "localhost:*"))';
const MACOS_HELPER_DIAGNOSTIC_TIMEOUT_MS = 5_000;
const MACOS_HELPER_DIAGNOSTIC_OUTPUT_LIMIT = 8_192;
const MACOS_CODESIGN_PATH = "/usr/bin/codesign";
const MACOS_SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";
const MACOS_XATTR_PATH = "/usr/bin/xattr";
const MACOS_OTOOL_PATH = "/usr/bin/otool";
const LINUX_INTERFACE_DIAGNOSTIC_LIMIT = 32;
/** Environment needed by the runner-user verifier after sudo creates the network namespace. */
export const LINUX_SUDO_PRESERVE_ENV = [
  "DISPLAY",
  "XAUTHORITY",
  "HOME",
  "PATH",
  "MCODE_TERMINAL_RELEASE_TEST",
  "MCODE_TERMINAL_BACKEND",
  "MCODE_TERMINAL_RELEASE_FAULT",
  "MCODE_RELEASE_NODE",
  "MCODE_RELEASE_SCRIPT",
  "MCODE_TERMINAL_PRODUCT_NAMESPACE",
].join(",");

/** Marks the verifier process that was re-executed inside the Linux namespace. */
export const LINUX_PRODUCT_NAMESPACE_MARKER = "MCODE_TERMINAL_PRODUCT_NAMESPACE";

function readLinuxProductNetworkInterfaces(readdir) {
  try {
    const interfaces = readdir("/sys/class/net");
    return Array.isArray(interfaces) && interfaces.every((name) => typeof name === "string")
      ? interfaces.slice().sort()
      : null;
  } catch {
    return null;
  }
}

/** Returns bounded Linux namespace proof diagnostics without exposing environment values. */
export function describeLinuxProductNamespaceProof({
  env = process.env,
  readdir = (directory) => readdirSync(directory),
} = {}) {
  const interfaces = readLinuxProductNetworkInterfaces(readdir);
  return {
    markerPresent: env[LINUX_PRODUCT_NAMESPACE_MARKER] === "1",
    interfaces: interfaces?.slice(0, LINUX_INTERFACE_DIAGNOSTIC_LIMIT) ?? null,
    interfaceCount: interfaces?.length ?? null,
    interfacesTruncated: interfaces !== null && interfaces.length > LINUX_INTERFACE_DIAGNOSTIC_LIMIT,
  };
}

function formatLinuxProductNamespaceProofDiagnostics(diagnostics) {
  const interfaces = diagnostics.interfaces === null
    ? "unreadable"
    : JSON.stringify(diagnostics.interfaces);
  const suffix = diagnostics.interfacesTruncated ? "; interfacesTruncated=true" : "";
  return `marker=${diagnostics.markerPresent ? "present" : "absent"}; interfaces=${interfaces}; interfaceCount=${diagnostics.interfaceCount ?? "unknown"}${suffix}`;
}

/** Proves that the marked verifier exposes only the configured loopback interface. */
export function hasLinuxProductNamespaceProof({
  env = process.env,
  readdir = (directory) => readdirSync(directory),
} = {}) {
  const diagnostics = describeLinuxProductNamespaceProof({ env, readdir });
  return diagnostics.markerPresent &&
    diagnostics.interfaceCount === 1 &&
    diagnostics.interfaces?.[0] === "lo" &&
    !diagnostics.interfacesTruncated;
}

/** Returns whether the Linux product command still needs its namespace re-exec. */
export function shouldReexecLinuxProductVerifier({
  command,
  platform,
  env = process.env,
  readdir = (directory) => readdirSync(directory),
}) {
  return (
    command === "product" &&
    platform === "linux" &&
    !hasLinuxProductNamespaceProof({ env, readdir })
  );
}

/** Validates the explicit packaged release-test launch boundary. */
export function validateProductSmokeLaunchInput({
  env,
  resourcesPresent,
  fault,
}) {
  if (!resourcesPresent) throw new Error("Packaged resources are required");
  if (env.MCODE_TERMINAL_RELEASE_TEST !== "1") {
    throw new Error("MCODE_TERMINAL_RELEASE_TEST=1 is required");
  }
  if (env.MCODE_TERMINAL_BACKEND !== "modern") {
    throw new Error("MCODE_TERMINAL_BACKEND=modern is required");
  }
  const envFault = env.MCODE_TERMINAL_RELEASE_FAULT;
  if (envFault !== undefined && envFault !== fault) {
    throw new Error("Release-test fault input does not match the lane");
  }
  const releaseKeys = Object.keys(env).filter((key) =>
    key.startsWith("MCODE_TERMINAL_RELEASE_"),
  );
  const unknown = releaseKeys.filter(
    (key) =>
      !["MCODE_TERMINAL_RELEASE_TEST", "MCODE_TERMINAL_RELEASE_FAULT"].includes(key),
  );
  if (unknown.length > 0) throw new Error(`Unknown release-test input: ${unknown[0]}`);
  if (fault !== undefined && !PRODUCT_SMOKE_FAULTS.includes(fault)) {
    throw new Error(`Unknown release-test fault: ${fault}`);
  }
  if (fault !== undefined && Buffer.byteLength(fault, "utf8") > 64) {
    throw new Error("Release-test fault is oversized");
  }
  return Object.freeze({
    releaseTest: true,
    backend: "modern",
    ...(fault === undefined ? {} : { fault }),
  });
}

/** Parses one bounded product-lane command without accepting repeated options. */
export function parseProductSmokeArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!option.startsWith("--") || index + 1 >= argv.length) {
      throw new Error("Product smoke options require one value");
    }
    const key = option.slice(2);
    if (Object.hasOwn(values, key)) throw new Error(`Repeated product smoke option: ${option}`);
    values[key] = argv[index + 1];
    index += 1;
  }
  return values;
}

/** Classifies only observations returned by the packaged product probe. */
export function classifyProductSmokeOutcome({
  fault,
  observation,
}) {
  const initial = observation.capabilities.initial;
  const history = observation.capabilities.history;
  const generations = new Set(
    history.map((capability) => capability.host?.generation).filter(Boolean),
  );
  const replacementCount = Math.max(0, generations.size - 1);
  const current = history.at(-1);
  const startupFallback = initial.backend === "legacy";
  const affectedSessionFailed = observation.sessions.some(
    (session) => session.state === "failed" || session.exitReason !== null,
  );
  const replacementHealthy =
    replacementCount === 1 && current?.host?.state === "healthy";
  const newSessionHealthy = observation.newSession?.state === "running";
  const diagnosticsObserved =
    observation.typedErrors.length > 0 || observation.sessions.some((session) => session.exitReason !== null);
  const startupFault = fault === "startup-health-failure" || fault === "missing-native-artifact";
  const passed =
    fault === undefined
      ? initial.backend === "modern" && !startupFallback && replacementCount === 0
      : startupFault
        ? initial.backend === "legacy" && observation.retry?.backend === "modern"
        : initial.backend === "modern" &&
          !startupFallback &&
          affectedSessionFailed &&
          replacementHealthy &&
          newSessionHealthy &&
          diagnosticsObserved;
  return {
    passed,
    startupFallback,
    affectedSessionFailed,
    replacementHealthy,
    newSessionHealthy,
    diagnosticsObserved,
    expectedBackend: startupFault ? "legacy" : "modern",
    replacementCount,
  };
}

/** Builds the OS-level loopback-only launch plan. Proxy settings are not used. */
export function buildLoopbackIsolationPlan(platform, executablePath) {
  if (!existsSync(executablePath)) throw new Error("Packaged Electron executable is missing");
  const resolvedExecutablePath = path.resolve(executablePath);
  if (platform === "win32") {
    return {
      mode: "windows-firewall",
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command"],
      executablePath: resolvedExecutablePath,
    };
  }
  if (platform === "linux") {
    return {
      mode: "linux-network-namespace",
      command: "sudo",
      args: [
        "-n",
        `--preserve-env=${LINUX_SUDO_PRESERVE_ENV}`,
        "unshare",
        "--net",
        "/bin/sh",
        "-c",
        LINUX_NAMESPACE_SCRIPT,
      ],
      executablePath: resolvedExecutablePath,
    };
  }
  if (platform === "darwin") {
    return {
      mode: "macos-network-sandbox",
      command: "sandbox-exec",
      args: ["-p", MACOS_LOOPBACK_PROFILE],
      executablePath: resolvedExecutablePath,
    };
  }
  throw new Error(`Unsupported isolation platform: ${platform}`);
}

function boundedDiagnosticText(value) {
  const text = value == null ? "" : String(value);
  return text.length > MACOS_HELPER_DIAGNOSTIC_OUTPUT_LIMIT
    ? `${text.slice(0, MACOS_HELPER_DIAGNOSTIC_OUTPUT_LIMIT)}...`
    : text;
}

function runBoundedDiagnosticCommand(command, args, cwd, runCommand) {
  try {
    const result = runCommand(command, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: MACOS_HELPER_DIAGNOSTIC_OUTPUT_LIMIT,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: MACOS_HELPER_DIAGNOSTIC_TIMEOUT_MS,
    });
    return {
      command,
      args,
      cwd,
      ok: result?.status === 0 && !result.error && !result.signal,
      status: result?.status ?? null,
      signal: result?.signal ?? null,
      error: boundedDiagnosticText(result?.error?.message ?? result?.error),
      stdout: boundedDiagnosticText(result?.stdout),
      stderr: boundedDiagnosticText(result?.stderr),
    };
  } catch (error) {
    return {
      command,
      args,
      cwd,
      ok: false,
      status: null,
      signal: null,
      error: boundedDiagnosticText(error instanceof Error ? error.message : error),
      stdout: "",
      stderr: "",
    };
  }
}

function formatHelperDiagnosticFailure(report) {
  const failed = ["codesignDetail", "codesignVerify", "direct", "sandboxed"]
    .filter((key) => !report[key].ok)
    .map((key) => ({ key, result: report[key] }));
  return boundedDiagnosticText(JSON.stringify({ ...report, failed }));
}

/** Probes exact Darwin helper launchability directly and under the product sandbox. */
export function diagnoseDarwinSpawnHelper({
  targetPlatform,
  helperPath,
  hostPlatform = process.platform,
  runCommand = spawnSync,
}) {
  if (targetPlatform !== "darwin" || hostPlatform !== "darwin") return null;
  const resolvedHelperPath = path.resolve(helperPath);
  const cwd = path.dirname(resolvedHelperPath);
  const report = {
    helperPath: resolvedHelperPath,
    cwd,
    codesignDetail: runBoundedDiagnosticCommand(
      MACOS_CODESIGN_PATH,
      ["-dvv", resolvedHelperPath],
      cwd,
      runCommand,
    ),
    codesignVerify: runBoundedDiagnosticCommand(
      MACOS_CODESIGN_PATH,
      ["--verify", "--strict", resolvedHelperPath],
      cwd,
      runCommand,
    ),
    direct: runBoundedDiagnosticCommand(
      resolvedHelperPath,
      [cwd, "/usr/bin/true"],
      cwd,
      runCommand,
    ),
    sandboxed: runBoundedDiagnosticCommand(
      MACOS_SANDBOX_EXEC_PATH,
      ["-p", MACOS_LOOPBACK_PROFILE, resolvedHelperPath, cwd, "/usr/bin/true"],
      cwd,
      runCommand,
    ),
  };
  if (Object.values(report).some((value) => value && value.ok === false)) {
    report.xattrs = runBoundedDiagnosticCommand(
      MACOS_XATTR_PATH,
      ["-l", resolvedHelperPath],
      cwd,
      runCommand,
    );
    report.dependencies = runBoundedDiagnosticCommand(
      MACOS_OTOOL_PATH,
      ["-L", resolvedHelperPath],
      cwd,
      runCommand,
    );
    throw new Error(
      `Darwin spawn-helper launchability diagnostic failed: ${formatHelperDiagnosticFailure(report)}`,
    );
  }
  return report;
}

/** Rejects an isolation receipt that silently allowed fallback or egress. */
export function assertLoopbackIsolationReceipt(receipt) {
  if (receipt?.mode === undefined || receipt.mode === "none") {
    throw new Error("OS-level loopback isolation was not installed");
  }
  if (receipt.loopbackAllowed !== true) {
    throw new Error("Loopback isolation receipt is incomplete");
  }
  return receipt;
}

/** Installs and records the target runner's loopback-only egress boundary. */
export function installLoopbackIsolation({ platform, executablePath }) {
  const plan = buildLoopbackIsolationPlan(platform, executablePath);
  if (platform === "win32") {
    const group = `McodeTerminalRelease-${process.pid}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$program = $env:MCODE_RELEASE_PROGRAM",
      "$group = $env:MCODE_RELEASE_FIREWALL_GROUP",
      "$external = @('0.0.0.0-126.255.255.255','128.0.0.0-255.255.255.255','::2-3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff','4000::/2','8000::/2','c000::/2')",
      "New-NetFirewallRule -DisplayName ($group + '-external') -Group $group -Direction Outbound -Action Block -Program $program -RemoteAddress $external -Profile Any | Out-Null",
    ].join("; ");
    execFileSync(plan.command, [...plan.args, script], {
      env: {
        ...process.env,
        MCODE_RELEASE_PROGRAM: plan.executablePath,
        MCODE_RELEASE_FIREWALL_GROUP: group,
      },
      stdio: "pipe",
    });
    return {
      mode: plan.mode,
      loopbackAllowed: true,
      group,
      cleanupRequired: true,
    };
  }
  execFileSync(plan.command, platform === "linux" ? plan.args : ["-p", MACOS_LOOPBACK_PROFILE, "/usr/bin/true"], { stdio: "pipe" });
  return { mode: plan.mode, loopbackAllowed: true };
}

/** Removes only the exact temporary Windows firewall group created by the lane. */
export function cleanupLoopbackIsolation(receipt) {
  if (receipt?.mode !== "windows-firewall") return receipt;
  if (typeof receipt.group !== "string" || !/^McodeTerminalRelease-\d+-[a-f0-9]{12}$/.test(receipt.group)) {
    throw new Error("Invalid release firewall group");
  }
  execFileSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "$ErrorActionPreference = 'Stop'; Get-NetFirewallRule -Group $env:MCODE_RELEASE_FIREWALL_GROUP | Remove-NetFirewallRule",
  ], {
    env: { ...process.env, MCODE_RELEASE_FIREWALL_GROUP: receipt.group },
    stdio: "pipe",
  });
  return { ...receipt, cleanupRequired: false };
}

/** Builds the one-time Linux namespace re-exec for the packaged product verifier. */
export function buildLinuxProductVerifierLaunch({
  nodePath = process.execPath,
  scriptPath = fileURLToPath(import.meta.url),
  args = [],
}) {
  return {
    command: "xvfb-run",
    args: [
      "-a",
      "sudo",
      "-n",
      `--preserve-env=${LINUX_SUDO_PRESERVE_ENV}`,
      "unshare",
      "--net",
      "/bin/sh",
      "-c",
      `${LINUX_NAMESPACE_SCRIPT}; test -n "\${SUDO_UID:-}"; test -n "\${SUDO_GID:-}"; MCODE_TERMINAL_PRODUCT_NAMESPACE=1 exec /usr/bin/setpriv --reuid="$SUDO_UID" --regid="$SUDO_GID" --init-groups -- "$MCODE_RELEASE_NODE" "$MCODE_RELEASE_SCRIPT" "$@"`,
      "--",
      ...args,
    ],
    env: {
      MCODE_RELEASE_NODE: path.resolve(nodePath),
      MCODE_RELEASE_SCRIPT: path.resolve(scriptPath),
      [LINUX_PRODUCT_NAMESPACE_MARKER]: "1",
    },
  };
}

/** Polls a bounded PID set until all descendants are gone. */
export async function pollProcessCleanup(
  pids,
  { isAlive = (pid) => isProcessAlive(pid), timeoutMs = CLEANUP_BOUND_MS, intervalMs = 100 } = {},
) {
  const startedAt = Date.now();
  const uniquePids = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
  let alive = uniquePids.filter(isAlive);
  while (alive.length > 0 && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    alive = uniquePids.filter(isAlive);
  }
  return {
    pids: uniquePids,
    aliveAfterCleanup: alive,
    cleanupDurationMs: Math.min(Date.now() - startedAt, timeoutMs),
    passed: alive.length === 0,
  };
}

/** Hashes bounded packaged resources before and after the smoke lane. */
export function hashPackagedResources(rootPath) {
  const files = new Set();
  const addIfFile = (filePath) => {
    if (existsSync(filePath)) files.add(filePath);
  };
  addIfFile(path.join(rootPath, "app.asar"));
  addIfFile(path.join(rootPath, "app.asar.unpacked", "dist", "server", "pty-host.cjs"));
  addIfFile(path.join(rootPath, "bin", "mcode-server"));
  addIfFile(path.join(rootPath, "bin", "mcode-server.exe"));
  const collectNative = (directory, names, depth = 0) => {
    if (!existsSync(directory) || depth > 8) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      if (entry.isFile() && names.has(entry.name)) addIfFile(filePath);
      else if (entry.isDirectory()) collectNative(filePath, names, depth + 1);
      if (files.size > MAX_TERMINAL_ARTIFACT_FILES) throw new Error("Terminal artifact hash inventory is oversized");
    }
  };
  const unpacked = path.join(rootPath, "app.asar.unpacked", "node_modules");
  collectNative(path.join(unpacked, "node-pty"), new Set(["pty.node", "conpty.dll", "OpenConsole.exe", "spawn-helper"]));
  collectNative(path.join(unpacked, "koffi"), new Set(["koffi.node"]));
  return Object.fromEntries(
    [...files].sort().map((filePath) => [
      path.relative(rootPath, filePath).replaceAll(path.sep, "/"),
      createHash("sha256").update(readFileSync(filePath)).digest("hex"),
    ]),
  );
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function findPackagedTarget(releaseDir, platform, arch) {
  const candidates =
    platform === "windows"
      ? [{ root: path.join(releaseDir, "win-unpacked"), executable: "Mcode.exe" }]
      : platform === "linux"
        ? [{ root: path.join(releaseDir, "linux-unpacked"), executable: "mcode-desktop" }]
        : [
            { root: path.join(releaseDir, arch === "arm64" ? "mac-arm64" : "mac"), executable: path.join("Mcode.app", "Contents", "MacOS", "Mcode") },
          ];
  for (const candidate of candidates) {
    const root = path.resolve(candidate.root);
    const executablePath = path.join(root, candidate.executable);
    const resourcesRoot =
      platform === "macos"
        ? path.join(root, "Mcode.app", "Contents", "Resources")
        : path.join(root, "resources");
    if (existsSync(executablePath) && existsSync(resourcesRoot)) {
      return { root, executablePath, resourcesRoot };
    }
  }
  throw new Error(`Unpacked ${platform}-${arch} Electron target is missing`);
}

/** Builds the isolated packaged Electron launch command for one target OS. */
export function buildProductLaunch({
  target,
  isolationReceipt,
  launchArgs,
  platform,
  env = process.env,
  readdir = (directory) => readdirSync(directory),
}) {
  const executablePath = path.resolve(target.executablePath);
  const isolatedLaunchArgs = ["--no-sandbox", ...launchArgs];
  if (platform === "linux" && isolationReceipt.mode !== "linux-network-namespace") {
    throw new Error("Linux product launch requires Linux network namespace isolation");
  }
  if (isolationReceipt.mode === "linux-network-namespace") {
    if (!hasLinuxProductNamespaceProof({ env, readdir })) {
      const diagnostics = describeLinuxProductNamespaceProof({ env, readdir });
      throw new Error(
        `Linux Electron launch requires the isolated product verifier (${formatLinuxProductNamespaceProofDiagnostics(diagnostics)})`,
      );
    }
    return {
      command: executablePath,
      args: isolatedLaunchArgs,
      env: {},
    };
  }
  if (isolationReceipt.mode === "macos-network-sandbox") {
    return {
      command: "sandbox-exec",
      args: ["-p", MACOS_LOOPBACK_PROFILE, executablePath, ...isolatedLaunchArgs],
      env: {},
    };
  }
  return { command: executablePath, args: launchArgs, env: {} };
}

/** Loads the shared process-cleanup workload through a cross-platform file URL. */
export async function loadProcessCleanupWorkload() {
  const modulePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../server/src/services/terminal-workload-corpus.ts",
  );
  const corpus = await import(pathToFileURL(modulePath).href);
  return corpus.getTerminalWorkload("process-cleanup");
}

function commandForWorkload(workload) {
  const source = Buffer.from(workload.program.source, "utf8").toString("base64");
  return `node -e "eval(Buffer.from('${source}','base64').toString())"`;
}

/** Sends one literal workload command through the packaged Terminal input. */
export async function sendTerminalCommand(page, command) {
  await page.keyboard.insertText(command);
  await page.keyboard.press("Enter");
}

/** Summarizes one renderer probe for bounded packaged-smoke failure evidence. */
export function summarizeReleaseProbe(probe) {
  const lines = Array.isArray(probe?.normalizedLines) ? probe.normalizedLines : [];
  const cursor = probe?.cursor;
  return {
    cols: Number.isInteger(probe?.cols) ? probe.cols : null,
    rows: Number.isInteger(probe?.rows) ? probe.rows : null,
    cursor: {
      x: Number.isInteger(cursor?.x) ? cursor.x : null,
      y: Number.isInteger(cursor?.y) ? cursor.y : null,
    },
    normalizedLines: lines
      .slice(-PROBE_DIAGNOSTIC_LINE_LIMIT)
      .map((line) => {
        const text = String(line);
        if (text.length <= PROBE_DIAGNOSTIC_LINE_LENGTH) return text;
        const suffixLength = Math.floor((PROBE_DIAGNOSTIC_LINE_LENGTH - 1) / 2);
        const prefixLength = PROBE_DIAGNOSTIC_LINE_LENGTH - suffixLength - 1;
        return `${text.slice(0, prefixLength)}…${text.slice(-suffixLength)}`;
      }),
  };
}

/** Formats bounded renderer focus and terminal-buffer evidence for a timeout. */
export function formatProbeTimeoutDiagnostics({ probe, focus }) {
  const diagnostics = {
    lastProbe: probe ? summarizeReleaseProbe(probe) : null,
    focus: focus
      ? {
          hasFocus: focus.hasFocus === true,
          tagName: typeof focus.tagName === "string" ? focus.tagName : null,
          className: typeof focus.className === "string" ? focus.className : null,
          testId: typeof focus.testId === "string" ? focus.testId : null,
        }
      : null,
  };
  return JSON.stringify(diagnostics).slice(0, PROBE_DIAGNOSTIC_MAX_LENGTH);
}

async function waitForProbe(page, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  const probe = page.locator("[data-terminal-release-test-probe]").first();
  let lastProbe;
  while (Date.now() < deadline) {
    const value = await probe.getAttribute("data-terminal-release-test-probe");
    if (value) {
      const parsed = JSON.parse(value);
      lastProbe = parsed;
      if (predicate(parsed)) return;
    }
    await page.waitForTimeout(100);
  }
  const focus = await page
    .evaluate(() => {
      const active = document.activeElement;
      return {
        hasFocus: document.hasFocus(),
        tagName: active?.tagName,
        className: typeof active?.className === "string" ? active.className : undefined,
        testId: active?.getAttribute("data-testid") ?? undefined,
      };
    })
    .catch(() => undefined);
  throw new Error(
    `Timed out waiting for the renderer release probe\n${formatProbeTimeoutDiagnostics({
      probe: lastProbe,
      focus,
    })}`,
  );
}

async function readRuntimeObservation(page) {
  const value = await page.locator("html").getAttribute("data-terminal-release-test-runtime");
  if (!value) {
    const error = await page.locator("html").getAttribute("data-terminal-release-test-runtime-error");
    throw new Error(error || "Renderer runtime release observation is missing");
  }
  return JSON.parse(value);
}

async function waitForRuntime(page, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const observation = await readRuntimeObservation(page);
      if (predicate(observation)) return observation;
    } catch {
      // The renderer may be between Terminal mounts. The bounded deadline is the guard.
    }
    await page.waitForTimeout(100);
  }
  throw new Error("Timed out waiting for renderer runtime release observation");
}

/** Appends launch output while retaining only the bounded diagnostic tail. */
export function appendBoundedOutputTail(tail, chunk) {
  return `${tail}${chunk}`.slice(-LAUNCH_OUTPUT_TAIL_LIMIT);
}

/** Attaches a non-empty bounded launch tail while preserving the original error. */
export function attachLaunchOutputTail(error, launchOutputTail) {
  const tail = launchOutputTail.trim();
  if (!tail) return error;
  const detail = `\nLaunch output tail:\n${tail}`;
  if (error instanceof Error) {
    if (error.message.toLowerCase().includes(detail.toLowerCase())) return error;
    error.message += detail;
    return error;
  }
  return new Error(`${String(error)}${detail}`, { cause: error });
}

/** Builds the environment used to boot one packaged product target. */
export function buildProductBootEnv({ env, targetRoot, bootFault }) {
  const bootEnv = {
    ...env,
    MCODE_AGENT_RUNTIME: "1",
    MCODE_AGENT_FIXTURE_REPO: targetRoot,
    MCODE_TERMINAL_RELEASE_TEST: "1",
    MCODE_TERMINAL_BACKEND: "modern",
  };
  if (bootFault) bootEnv.MCODE_TERMINAL_RELEASE_FAULT = bootFault;
  else delete bootEnv.MCODE_TERMINAL_RELEASE_FAULT;
  return bootEnv;
}

/** Opens the current packaged Terminal session after requiring the rail control. */
export async function openTerminal(page) {
  const terminalToggle = page.locator('[data-rail-tab="terminal"]').first();
  if (!(await terminalToggle.count())) throw new Error("Terminal control is missing");
  await terminalToggle.click();
  const terminal = page.getByTestId("terminal-render-content").last();
  await terminal.waitFor({ state: "visible", timeout: 15_000 });
  await terminal.click();
  return terminal;
}

/** Waits for the release-test workspace bootstrap to expose a visible Terminal control. */
export async function waitForTerminalControl(
  page,
  { timeoutMs = 30_000, intervalMs = 100 } = {},
) {
  const releaseTestBridgeEnabled = await page.evaluate(
    () => window.desktopBridge?.terminalReleaseTest?.enabled === true,
  );
  if (!releaseTestBridgeEnabled) {
    throw new Error("Terminal release-test bridge is missing");
  }
  const terminalToggle = page.locator('[data-rail-tab="terminal"]').first();
  const html = page.locator("html");
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const bootstrapError = await html.getAttribute(
      "data-terminal-release-test-bootstrap-error",
    );
    if (bootstrapError) throw new Error(bootstrapError);
    if ((await terminalToggle.count()) > 0 && await terminalToggle.isVisible()) return;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error("Timed out waiting for visible Terminal control");
    }
    await page.waitForTimeout(Math.min(intervalMs, remainingMs));
  }
}

async function runTerminalWorkload(page, terminal, workload) {
  await sendTerminalCommand(page, commandForWorkload(workload));
  await waitForProbe(page, (snapshot) => snapshot.normalizedLines.some((line) => line.includes(workload.synchronizationMarker)));
  const initialProbe = JSON.parse(await terminal.getAttribute("data-terminal-release-test-probe"));
  await page.setViewportSize({ width: 1_040, height: 620 });
  await page.waitForTimeout(150);
  const resizedProbe = JSON.parse(await terminal.getAttribute("data-terminal-release-test-probe"));
  if (resizedProbe.cols === initialProbe.cols && resizedProbe.rows === initialProbe.rows) {
    throw new Error("Product resize did not change xterm dimensions");
  }
  const longLine = "MCODE_RELEASE_WRAP_" + "x".repeat(Math.max(80, resizedProbe.cols + 20));
  await sendTerminalCommand(page, `printf '${longLine}\\n'`);
  await waitForProbe(page, (snapshot) => snapshot.normalizedLines.some((line) => line.includes("MCODE_RELEASE_WRAP_")));
  const finalProbe = JSON.parse(await terminal.getAttribute("data-terminal-release-test-probe"));
  if (!finalProbe.lines.some((line) => line.wrapped)) throw new Error("Final xterm state has no wrapped cell evidence");
  return { finalProbe, output: finalProbe.normalizedLines.join("\n") };
}

function extractWorkloadPids(output) {
  return ["parent", "child", "grandchild"].map((role) => {
    const match = output.match(new RegExp(`WF:cleanup:${role}:(\\d+)`));
    if (!match) throw new Error(`Process-cleanup ${role} PID marker is missing`);
    return Number(match[1]);
  });
}

function extractHostPids(runtime) {
  return [
    ...new Set(
      runtime.capabilityHistory
        .map((capability) => capability.releaseTest?.hostPid)
        .filter((pid) => Number.isInteger(pid) && pid > 0),
    ),
  ];
}

/** Releases every handle retained by a completed or failed product launch. */
export function releaseProductProcess(child) {
  child.kill("SIGTERM");
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}

/** Waits a bounded interval for Electron to navigate a renderer page to a packaged file URL. */
export async function waitForRendererPage(
  browser,
  { timeoutMs = 45_000, intervalMs = 100, getDiagnostics = () => ({}) } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pages = browser.contexts().flatMap((context) => context.pages());
    for (const page of pages) {
      if (page.url().startsWith("file:")) return page;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const { exitCode, launchOutputTail } = getDiagnostics();
  const details = [`outer child exit code: ${exitCode ?? "pending"}`];
  if (launchOutputTail?.trim()) {
    details.push(`launch output tail:\n${launchOutputTail.trim()}`);
  }
  throw new Error(`Packaged Electron renderer page is missing\n${details.join("\n")}`);
}

async function runProductBoot({ target, env, bootFault, isolationReceipt, workload, platform }) {
  const bootStartedAt = performance.now();
  const cdpPort = 39_000 + (parseInt(randomUUID().slice(0, 4), 16) % 500);
  const launchArgs = [`--remote-debugging-port=${cdpPort}`];
  const launch = buildProductLaunch({
    target,
    isolationReceipt,
    launchArgs,
    platform,
  });
  const bootEnv = buildProductBootEnv({ env, targetRoot: target.root, bootFault });
  const child = spawn(launch.command, launch.args, {
    cwd: target.root,
    env: { ...bootEnv, ...launch.env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let launchOutputTail = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    launchOutputTail = appendBoundedOutputTail(launchOutputTail, chunk);
  });
  child.stderr?.on("data", (chunk) => {
    launchOutputTail = appendBoundedOutputTail(launchOutputTail, chunk);
  });
  child.on("error", (error) => {
    launchOutputTail = appendBoundedOutputTail(launchOutputTail, error.message);
  });
  const browser = await (async () => {
    const deadline = Date.now() + 15_000;
    let connectionError = "";
    while (Date.now() < deadline) {
      try {
        return await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, {
          timeout: 1_000,
        });
      } catch (error) {
        connectionError = error instanceof Error ? error.message : String(error);
        if (child.exitCode !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    const detail = [connectionError, launchOutputTail.trim()].filter(Boolean).join("\n");
    releaseProductProcess(child);
    throw new Error(
      `Packaged Electron CDP did not become available (exit ${child.exitCode ?? "pending"}): ${detail || "no launch diagnostics"}`,
    );
  })();
  try {
    const page = await waitForRendererPage(browser, {
      getDiagnostics: () => ({ exitCode: child.exitCode, launchOutputTail }),
    });
    await page.waitForLoadState("domcontentloaded");
    const typedErrors = [];
    page.on("websocket", (socket) => {
      socket.on("framereceived", (frame) => {
        if (typeof frame !== "string") return;
        try {
          const parsed = JSON.parse(frame);
          const code = parsed?.error?.code;
          if (typeof code === "string" && typedErrors.length < 32) typedErrors.push(code);
        } catch {
          // Binary or non-JSON frames are not diagnostics.
        }
      });
    });
    await waitForTerminalControl(page);
    const initialTerminal = await openTerminal(page);
    const initialRuntime = await waitForRuntime(page, (runtime) => runtime.capabilities !== undefined);
    const initialCapabilities = initialRuntime.capabilities;
    if (bootFault === "startup-health-failure" || bootFault === "missing-native-artifact") {
      const startupRuntime = await waitForRuntime(page, (runtime) => runtime.capabilities.backend === "legacy");
      const hostPids = Number.isInteger(initialCapabilities.releaseTest?.hostPid)
        ? [initialCapabilities.releaseTest.hostPid]
        : [];
      return {
        initialCapabilities,
        runtime: startupRuntime,
        renderer: null,
        processPids: [child.pid, ...hostPids],
        hostPids,
        typedErrors,
        newSession: null,
        startupFallbackDurationMs: Math.round(performance.now() - bootStartedAt),
      };
    }
    const terminal = initialTerminal;
    let workloadResult;
    if (bootFault === "containment-failure") {
      await waitForRuntime(page, (runtime) => runtime.capabilityHistory.some((capability) => capability.host?.state === "unhealthy"));
    } else if (bootFault === undefined) {
      workloadResult = await runTerminalWorkload(page, terminal, workload);
    }
    let runtime = await waitForRuntime(page, (value) => {
      if (bootFault === undefined) return value.capabilityHistory.length > 0;
      const generations = new Set(value.capabilityHistory.map((capability) => capability.host?.generation).filter(Boolean));
      const failed = value.sessionHistory.flat().some((session) => session.state === "failed");
      return generations.size === 2 && value.capabilities.host?.state === "healthy" && failed;
    });
    let newSession = null;
    const hostPids = extractHostPids(runtime);
    let processPids = [child.pid, ...hostPids];
    let renderer = workloadResult?.finalProbe ?? null;
    if (workloadResult) processPids.push(...extractWorkloadPids(workloadResult.output));
    if (bootFault !== undefined) {
      const replacementGeneration = runtime.capabilities.host?.generation;
      if (!replacementGeneration) throw new Error("Healthy replacement generation is missing");
      const replacementTerminal = await openTerminal(page);
      const replacementWorkload = await runTerminalWorkload(page, replacementTerminal, workload);
      runtime = await waitForRuntime(page, (value) => value.sessions.some((session) => session.state === "running" && session.hostGeneration === replacementGeneration));
      newSession = runtime.sessions.find((session) => session.state === "running" && session.hostGeneration === replacementGeneration) ?? null;
      if (!newSession) throw new Error("Replacement did not expose a running modern session");
      renderer = replacementWorkload.finalProbe;
      processPids.push(...extractWorkloadPids(replacementWorkload.output));
    }
    await page.keyboard.press("Control+C").catch(() => undefined);
    const close = page.getByRole("button", { name: /Close .*terminal|Close process tree/i }).first();
    if (await close.count()) await close.click();
    return {
      initialCapabilities,
      runtime,
      renderer,
      processPids,
      hostPids,
      typedErrors,
      newSession,
      startupFallbackDurationMs: null,
    };
  } catch (error) {
    throw attachLaunchOutputTail(error, launchOutputTail);
  } finally {
    const page = browser.contexts()[0]?.pages()[0];
    await page?.evaluate(() => window.desktopBridge?.window.perform("close")).catch(() => undefined);
    await browser.close().catch(() => undefined);
    releaseProductProcess(child);
  }
}

async function runProductPath({ target, env, fault, isolationReceipt, platform }) {
  const workload = await loadProcessCleanupWorkload();
  const firstBoot = await runProductBoot({ target, env, bootFault: fault, isolationReceipt, workload, platform });
  if (fault === "startup-health-failure" || fault === "missing-native-artifact") {
    const retry = await runProductBoot({ target, env, bootFault: undefined, isolationReceipt, workload, platform });
    return {
      workload,
      renderer: retry.renderer,
      processPids: [...firstBoot.processPids, ...retry.processPids],
      hostPids: [...new Set([...firstBoot.hostPids, ...retry.hostPids])],
      typedErrors: [...firstBoot.typedErrors, ...retry.typedErrors],
      observation: {
        capabilities: {
          initial: firstBoot.initialCapabilities,
          history: firstBoot.runtime.capabilityHistory,
        },
        sessions: [...firstBoot.runtime.sessionHistory.flat(), ...retry.runtime.sessionHistory.flat()],
        retry: retry.initialCapabilities,
        typedErrors: retry.typedErrors,
        newSession: retry.newSession,
      },
      startupFallbackDurationMs: firstBoot.startupFallbackDurationMs,
    };
  }
  const runtime = firstBoot.runtime;
  const newSession = firstBoot.newSession;
  const observation = {
    capabilities: { initial: firstBoot.initialCapabilities, history: runtime.capabilityHistory },
    sessions: runtime.sessionHistory.flat(),
    typedErrors: firstBoot.typedErrors,
    retry: null,
    newSession,
  };
  const outcome = classifyProductSmokeOutcome({ fault, observation });
  if (!outcome.passed) throw new Error(`Observed product smoke outcome failed for ${fault ?? "clean"}`);
  return {
    workload,
    renderer: firstBoot.renderer,
    processPids: firstBoot.processPids,
    hostPids: firstBoot.hostPids,
    typedErrors: firstBoot.typedErrors,
    observation,
    outcome,
    startupFallbackDurationMs: null,
  };
}


/** Runs the real packaged Electron renderer product path and writes one receipt. */
export async function runPackagedTerminalProductSmoke({
  releaseDir,
  platform = TARGET_PLATFORM[process.platform],
  arch = process.arch,
  fault,
  receiptDir,
  isolationReceipt,
}) {
  const target = findPackagedTarget(releaseDir, platform, arch);
  validateProductSmokeLaunchInput({
    env: process.env,
    resourcesPresent: existsSync(target.resourcesRoot),
    fault,
  });
  assertLoopbackIsolationReceipt(isolationReceipt);
  if (platform === "linux" && isolationReceipt.mode !== "linux-network-namespace") {
    throw new Error("Linux product smoke requires Linux network namespace isolation");
  }
  const darwinSpawnHelperDiagnostic =
    platform === "macos"
      ? diagnoseDarwinSpawnHelper({
          targetPlatform: "darwin",
          helperPath: resolveTargetTerminalNativeArtifacts({
            resourcesRoot: target.resourcesRoot,
            targetPlatform: "darwin",
            targetArch: arch,
          }).nodePtyRuntime[0],
        })
      : null;
  const hashesBefore = hashPackagedResources(target.resourcesRoot);
  const product = await runProductPath({
    target,
    fault,
    isolationReceipt,
    env: process.env,
    platform,
  });
  if (product.startupFallbackDurationMs !== null && product.startupFallbackDurationMs > 5_000) {
    throw new Error("Observed Terminal startup fallback exceeded five seconds");
  }
  const cleanup = await pollProcessCleanup(product.processPids);
  const hashesAfter = hashPackagedResources(target.resourcesRoot);
  if (JSON.stringify(hashesBefore) !== JSON.stringify(hashesAfter)) {
    throw new Error("Packaged resources changed during product smoke");
  }
  if (!cleanup.passed) throw new Error("Product smoke process cleanup exceeded three seconds");
  const receipt = {
    contractVersion: 1,
    kind: "packaged-terminal-product-smoke",
    generatedAt: new Date().toISOString(),
    status: "passed",
    fault: fault ?? null,
    darwinSpawnHelper: darwinSpawnHelperDiagnostic,
    startupFallbackDurationMs: product.startupFallbackDurationMs,
    observations: product.observation,
    isolation: isolationReceipt,
    renderer: product.renderer,
    workload: {
      id: product.workload.id,
      synchronizationMarker: product.workload.synchronizationMarker,
    },
    cleanup: { ...cleanup, hostPids: product.hostPids },
    packageHashesBefore: hashesBefore,
    packageHashesAfter: hashesAfter,
  };
  mkdirSync(receiptDir, { recursive: true });
  const receiptPath = path.join(receiptDir, fault ? `fault-${fault}.json` : "clean.json");
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
  return receipt;
}

async function main(argv) {
  const command = argv[2];
  const values = parseProductSmokeArguments(argv.slice(3));
  const platform = { windows: "windows", macos: "macos", linux: "linux" }[values.platform]
    ?? values.platform
    ?? TARGET_PLATFORM[process.platform];
  if (command === "isolation") {
    const receipt = installLoopbackIsolation({
      platform: { windows: "win32", macos: "darwin", linux: "linux" }[values.platform] ?? values.platform,
      executablePath: values.executable,
    });
    writeFileSync(values.output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
    return;
  }
  if (command === "cleanup") {
    if (!values.receipt) throw new Error("--receipt is required");
    const receipt = JSON.parse(readFileSync(values.receipt, "utf8"));
    cleanupLoopbackIsolation(receipt);
    return;
  }
  const releaseDir = values["release-dir"];
  const receiptDir = values["receipt-dir"];
  if (!releaseDir || !receiptDir) throw new Error("--release-dir and --receipt-dir are required");
  const fault = values.fault === undefined || values.fault === "" ? undefined : values.fault;
  const isolationReceipt = JSON.parse(readFileSync(values["isolation-receipt"], "utf8"));
  assertLoopbackIsolationReceipt(isolationReceipt);
  if (platform === "linux" && isolationReceipt.mode !== "linux-network-namespace") {
    throw new Error("Linux product smoke requires Linux network namespace isolation");
  }
  if (shouldReexecLinuxProductVerifier({ command, platform })) {
    if (process.env[LINUX_PRODUCT_NAMESPACE_MARKER] === "1") {
      const diagnostics = describeLinuxProductNamespaceProof();
      throw new Error(
        `Linux product namespace proof is missing (${formatLinuxProductNamespaceProofDiagnostics(diagnostics)})`,
      );
    }
    const launch = buildLinuxProductVerifierLaunch({
      args: argv.slice(2),
    });
    execFileSync(launch.command, launch.args, {
      env: { ...process.env, ...launch.env },
      stdio: "inherit",
    });
    return;
  }
  const receipt = await runPackagedTerminalProductSmoke({
    releaseDir,
    receiptDir,
    fault,
    isolationReceipt,
    platform,
    arch: values.arch ?? process.arch,
  });
  console.log(
    `[packaged-terminal-product-smoke] Passed ${receipt.fault ?? "clean"} product lane`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv).catch((error) => {
    console.error(`[packaged-terminal-product-smoke] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
