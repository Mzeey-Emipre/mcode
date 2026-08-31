/** Executes verification phases with bounded diagnostics and platform-safe cleanup. */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { SCRIPT_TEST_PHASE } from "./phase-definitions.mjs";

const isWindows = process.platform === "win32";
/** Maximum child output retained in memory for one phase. */
export const MAX_RETAINED_OUTPUT_BYTES = 16 * 1024;
/** Maximum failure excerpt printed to the terminal. */
export const MAX_FAILURE_EXCERPT_CHARS = 6_000;
/** Maximum displayed argv length in terminal diagnostics. */
export const MAX_DISPLAYED_ARGV_CHARS = 1_000;
/** Default phase timeout for direct verification. */
export const DEFAULT_PHASE_TIMEOUT_MS = 10 * 60 * 1_000;

function appendBounded(buffer, chunk, maxBytes = MAX_RETAINED_OUTPUT_BYTES) {
  const combined = Buffer.concat([buffer, Buffer.from(chunk)]);
  return combined.length <= maxBytes ? combined : combined.subarray(combined.length - maxBytes);
}

function terminateProcessTree(child, force = false) {
  if (!child.pid) return null;
  return isWindows ? terminateWindowsProcessTree(child) : terminatePosixProcessTree(child, force);
}

function terminateWindowsProcessTree(child) {
  const result = NodeChildProcess.spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (!result.error && result.status === 0) return null;
  try { child.kill("SIGKILL"); } catch { /* Process already exited. */ }
  return taskkillFailureExcerpt(result);
}

function taskkillFailureExcerpt(result) {
  const error = (result.error?.message
    ?? String(result.stderr ?? "").trim())
    || String(result.stdout ?? "").trim()
    || `taskkill exited with ${result.status ?? "an unknown status"}`;
  return error.slice(0, MAX_FAILURE_EXCERPT_CHARS);
}

function terminatePosixProcessTree(child, force) {
  try {
    process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch { /* Process already exited. */ }
  }
  return null;
}

function releaseDetachedChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}

function resolvePhaseExitCondition({ exitCondition, logError, spawnError, childSignal, code }) {
  if (logError) return "log-error";
  if (spawnError) return "spawn-error";
  if (exitCondition === "timeout" || exitCondition === "cancelled") return exitCondition;
  if (childSignal) return "signal";
  return code === 0 ? "success" : "nonzero";
}

function createPhaseResult({
  name,
  code,
  signal,
  exitCondition,
  spawnError,
  logError,
  terminationError,
  tail,
  startedAt,
  command,
  args,
  cwd,
  logPath,
}) {
  return {
    name,
    code,
    signal: signal ?? null,
    exitCondition,
    spawnError,
    logError,
    terminationError,
    output: tail.toString("utf8"),
    outputTruncated: tail.length >= MAX_RETAINED_OUTPUT_BYTES,
    durationMs: Date.now() - startedAt,
    command,
    args,
    cwd,
    argvDisplay: formatArgvDisplay(command, args),
    reproduction: formatSafeReproduction(command, args),
    logPath: logPath ?? null,
  };
}

/** Formats a bounded argv display without interpreting shell metacharacters. */
export function formatArgvDisplay(command, args = []) {
  const serialized = JSON.stringify([command, ...args]);
  return serialized.length <= MAX_DISPLAYED_ARGV_CHARS
    ? serialized
    : `${serialized.slice(0, MAX_DISPLAYED_ARGV_CHARS)}...[truncated]`;
}

/** Returns an exact command only when every token is shell-neutral and bounded. */
export function formatSafeReproduction(command, args = []) {
  const tokens = [command, ...args];
  if (!tokens.every((token) => /^[A-Za-z0-9_./:@=+\\-]+$/.test(token))) return null;
  const reproduction = tokens.join(" ");
  return reproduction.length <= MAX_DISPLAYED_ARGV_CHARS ? reproduction : null;
}

function resolveSafeExecutable(command, env) {
  if (!isWindows || NodePath.isAbsolute(command)) return command;
  try {
    const matches = NodeChildProcess.execFileSync("where.exe", [command], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }).split(/\r?\n/).filter(Boolean);
    return matches.find((match) => [".exe", ".com"].includes(NodePath.extname(match).toLowerCase()))
      ?? command;
  } catch {
    return command;
  }
}

/** Compares normalized PATH entries with platform-appropriate case sensitivity. */
export function pathEntriesMatch(left, right, { platform = process.platform } = {}) {
  const normalizedLeft = NodePath.resolve(left);
  const normalizedRight = NodePath.resolve(right);
  return platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

/** Places the Bun executable directory first in PATH for child phases. */
export function withBunPath(
  env = process.env,
  execPath = process.execPath,
  options = {},
) {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const currentPath = env[pathKey] ?? "";
  const bunDirectory = NodePath.dirname(execPath);
  const entries = currentPath.split(NodePath.delimiter).filter(Boolean);
  const remaining = entries.filter(
    (entry) => !pathEntriesMatch(entry, bunDirectory, options),
  );
  const normalized = { ...env };
  for (const key of Object.keys(normalized)) {
    if (key !== pathKey && key.toLowerCase() === "path") delete normalized[key];
  }
  normalized[pathKey] = [bunDirectory, ...remaining].join(NodePath.delimiter);
  return normalized;
}

/** Runs one phase while streaming its complete output and retaining a bounded tail. */
export function runPhase({
  name,
  command,
  args = [],
  cwd = process.cwd(),
  env = process.env,
  timeoutMs = DEFAULT_PHASE_TIMEOUT_MS,
  signal,
  logPath,
}) {
  return new Promise((resolve) => {
    const phaseEnv = withBunPath(env, process.execPath);
    const startedAt = Date.now();
    let tail = Buffer.alloc(0);
    let settled = false;
    let finishing = false;
    let exitCondition = "nonzero";
    let spawnError;
    let logError;
    let terminationError;
    const output = logPath ? NodeFS.createWriteStream(logPath, { flags: "wx" }) : null;
    const executable = resolveSafeExecutable(command, phaseEnv);
    const child = NodeChildProcess.spawn(executable, args, {
      cwd,
      env: phaseEnv,
      shell: false,
      detached: !isWindows,
      windowsHide: true,
    });
    const retain = (chunk) => {
      tail = appendBounded(tail, chunk);
      if (!logError && !output?.destroyed) output?.write(chunk);
    };
    child.stdout?.on("data", retain);
    child.stderr?.on("data", retain);

    const terminate = (force = false) => {
      terminationError ??= terminateProcessTree(child, force) ?? undefined;
    };

    let forceKillTimer;
    let settlementTimer;
    const complete = (code, childSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceKillTimer);
      clearTimeout(settlementTimer);
      signal?.removeEventListener("abort", cancel);
      releaseDetachedChild(child);
      const normalizedCode = code ?? 1;
      exitCondition = resolvePhaseExitCondition({
        exitCondition,
        logError,
        spawnError,
        childSignal,
        code: normalizedCode,
      });
      resolve(createPhaseResult({
        name,
        code: normalizedCode,
        signal: childSignal,
        exitCondition,
        spawnError,
        logError,
        terminationError,
        tail,
        startedAt,
        command,
        args,
        cwd,
        logPath,
      }));
    };
    const finish = (code, childSignal) => {
      if (settled || finishing) return;
      finishing = true;
      if (output && !output.destroyed && !logError) {
        output.end(() => complete(code, childSignal));
        return;
      }
      complete(code, childSignal);
    };
    output?.once("error", (error) => {
      if (settled) return;
      logError = error.message;
      tail = appendBounded(tail, Buffer.from(`[log error] ${error.message}\n`));
      terminate();
      output.destroy();
      complete(1, null);
    });
    const cancel = () => {
      exitCondition = "cancelled";
      terminate();
      if (!isWindows) {
        forceKillTimer = setTimeout(() => terminate(true), 500);
      }
      settlementTimer = setTimeout(() => finish(1, null), 2_000);
    };
    const timeout = setTimeout(() => {
      exitCondition = "timeout";
      terminate();
      if (!isWindows) {
        forceKillTimer = setTimeout(() => terminate(true), 500);
      }
      settlementTimer = setTimeout(() => finish(1, null), 2_000);
    }, timeoutMs);
    timeout.unref?.();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    child.on("error", (error) => {
      spawnError = typeof error.code === "string" ? `${error.code}: ${error.message}` : error.message;
      retain(Buffer.from(`[spawn error] ${spawnError}\n`));
      finish(1, null);
    });
    child.on("close", finish);
  });
}

function failureExcerpt(output) {
  if (output.length <= MAX_FAILURE_EXCERPT_CHARS) return output.trim();
  return `[earlier output omitted]\n${output.slice(-MAX_FAILURE_EXCERPT_CHARS).trim()}`;
}

/** Runs phases concurrently and prints concise summaries or bounded diagnostics. */
export async function runPhasesInParallel(
  phases,
  { printer = console.log, runDirectory, timeoutMs, signal, logIndexOffset = 0 } = {},
) {
  const results = await Promise.all(phases.map((phase, index) => runPhase(
    preparePhaseRun(phase, index, { runDirectory, timeoutMs, signal, logIndexOffset }),
  )));
  let code = 0;
  for (const result of results) {
    code ||= reportPhaseResult(result, printer);
  }
  return { code, results };
}

function preparePhaseRun(phase, index, { runDirectory, timeoutMs, signal, logIndexOffset }) {
  return {
    ...phase,
    timeoutMs: phase.timeoutMs ?? timeoutMs,
    signal,
    logPath: runDirectory ? phaseLogPath(runDirectory, phase, index, logIndexOffset) : undefined,
  };
}

function phaseLogPath(runDirectory, phase, index, logIndexOffset) {
  const position = String(logIndexOffset + index + 1).padStart(2, "0");
  const name = phase.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return NodePath.resolve(runDirectory, `${position}-${name}.log`);
}

function reportPhaseResult(result, printer) {
  const seconds = (result.durationMs / 1_000).toFixed(1);
  if (result.exitCondition === "success") {
    printer(`${result.name}: PASS (${seconds}s)`);
    return 0;
  }
  printer(`${result.name}: FAIL (${seconds}s)`);
  printPhaseFailure(result, printer);
  return result.code || 1;
}

function printPhaseFailure(result, printer) {
  printer(`Argv: ${result.argvDisplay}`);
  if (result.reproduction) printer(`Reproduce: ${result.reproduction}`);
  printer(`Working directory: ${result.cwd}`);
  printer(`Exit condition: ${phaseFailureDetail(result)}`);
  const excerpt = failureExcerpt(result.output);
  if (excerpt) printer(`Diagnostic excerpt:\n${excerpt}`);
  if (result.logPath) printer(`Full log: ${result.logPath}`);
}

function phaseFailureDetail(result) {
  if (result.exitCondition === "nonzero") return `nonzero exit ${result.code}`;
  if (result.exitCondition === "signal") return `signal ${result.signal}`;
  if (result.exitCondition === "spawn-error") return `spawn error: ${result.spawnError}`;
  return result.exitCondition;
}

/** Runs core phases in parallel, then agent script tests without resource contention. */
export async function runVerificationPhases(phases, options = {}) {
  const isScriptPhase = (phase) => phase.name === SCRIPT_TEST_PHASE.name || phase.group === "scripts";
  const corePhases = phases.filter((phase) => !isScriptPhase(phase));
  const scriptPhases = phases.filter(isScriptPhase);
  const core = await runPhasesInParallel(corePhases, options);
  if (scriptPhases.length === 0) return core;

  const scripts = await runPhasesInParallel(scriptPhases, {
    ...options,
    logIndexOffset: corePhases.length,
  });
  return {
    code: core.code || scripts.code,
    results: [...core.results, ...scripts.results],
  };
}
