#!/usr/bin/env node
import { spawn } from "node-pty";
import type { IPty } from "node-pty";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateTerminalWorkload,
  getTerminalWorkload,
  listTerminalWorkloads,
  TERMINAL_WORKLOAD_IDS,
  TERMINAL_WORKLOAD_LIMITS,
  type TerminalResizeObservation,
  type TerminalWorkloadCapture,
  type TerminalWorkloadId,
  type TerminalWorkloadResult,
  type TerminalWorkloadSpec,
} from "../src/features/terminal/testing/terminal-workload-corpus.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function resolveNodeExecutable(): string {
  if (!/[\\/]bun(?:\.exe)?$/i.test(process.execPath)) return process.execPath;
  const resolver = process.platform === "win32" ? "where.exe" : "which";
  const output = execFileSync(resolver, ["node"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const executable = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!executable) throw new Error("Node.js executable is required to run terminal workloads");
  return executable;
}

const NODE_EXECUTABLE = resolveNodeExecutable();

type WindowsPtyMode = "mcode" | "native";
type TerminalPtyMode = WindowsPtyMode | "platform-default";

interface CliOptions {
  readonly workloads: readonly TerminalWorkloadSpec[];
  readonly ptyMode: TerminalPtyMode;
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, durationMs));
}

function parseCliOptions(args: readonly string[]): CliOptions {
  let windowsPtyMode: WindowsPtyMode | undefined;
  const ids: TerminalWorkloadId[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") continue;
    if (arg === "--windows-pty") {
      if (process.platform !== "win32") {
        throw new Error("--windows-pty is only supported on Windows");
      }
      const mode = args[index + 1];
      if (mode !== "mcode" && mode !== "native") {
        throw new Error("--windows-pty expects mcode or native");
      }
      windowsPtyMode = mode;
      index += 1;
      continue;
    }
    if (arg !== "--workload" || !args[index + 1]) {
      throw new Error("Unknown argument: " + arg);
    }
    const id = args[index + 1]!;
    if (!TERMINAL_WORKLOAD_IDS.includes(id as TerminalWorkloadId)) {
      throw new Error("Unknown terminal workload: " + id);
    }
    ids.push(id as TerminalWorkloadId);
    index += 1;
  }
  const ptyMode: TerminalPtyMode = process.platform === "win32"
    ? (windowsPtyMode ?? "mcode")
    : "platform-default";
  return {
    workloads: ids.length > 0 ? ids.map((id) => getTerminalWorkload(id)) : [...listTerminalWorkloads()],
    ptyMode,
  };
}

interface CaptureState {
  outputBytes: number;
  detachedOutputBytes: number;
  storedBytes: number;
  outputTruncated: boolean;
  outputChunks: string[];
  connected: boolean;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function terminateProcess(pid: number, deadlineMs: number): Promise<void> {
  if (!isProcessAlive(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
  await sleep(Math.min(100, Math.max(0, deadlineMs - Date.now())));
  if (!isProcessAlive(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
  await sleep(Math.min(100, Math.max(0, deadlineMs - Date.now())));
}

function isClosedPtyError(error: unknown): boolean {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    if (code === "ERR_SOCKET_CLOSED" || error.message === "Socket is closed") return true;
  }
  return String(error).includes("Socket is closed");
}

function writeInput(pty: IPty, data: string): void {
  pty.write(process.platform === "win32" ? data.replace(/\n/g, "\r") : data);
}

function killPty(pty: IPty, tolerateClosedSocket: boolean): void {
  try {
    pty.kill();
  } catch (error) {
    if (!tolerateClosedSocket || !isClosedPtyError(error)) throw error;
  }
}

async function runWorkload(
  workload: TerminalWorkloadSpec,
  ptyMode: TerminalPtyMode,
): Promise<TerminalWorkloadResult> {
  const startedAt = Date.now();
  const state: CaptureState = {
    outputBytes: 0,
    detachedOutputBytes: 0,
    storedBytes: 0,
    outputTruncated: false,
    outputChunks: [],
    connected: true,
  };
  const resizeTrace: TerminalResizeObservation[] = [{
    kind: "initial",
    cols: workload.initialDimensions.cols,
    rows: workload.initialDimensions.rows,
    elapsedMs: 0,
  }];
  const workloadEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  workloadEnv.MCODE_TERMINAL_CORPUS = "1";
  const ptyOptions = {
    name: "xterm-256color",
    cols: workload.initialDimensions.cols,
    rows: workload.initialDimensions.rows,
    cwd: REPO_ROOT,
    env: workloadEnv,
    ...(process.platform === "win32" && ptyMode === "mcode" ? { useConptyDll: true } : {}),
    ...(process.platform === "win32" && ptyMode === "native" ? { useConpty: true } : {}),
  };
  const pty: IPty = spawn(NODE_EXECUTABLE, ["-e", workload.program.source], ptyOptions);
  let exited = false;
  let exitCode: number | null = null;
  let resolveExit!: () => void;
  const exitPromise = new Promise<void>((resolveExitPromise) => {
    resolveExit = resolveExitPromise;
  });
  const exitDisposable = pty.onExit(({ exitCode: code }) => {
    exited = true;
    exitCode = code;
    resolveExit();
  });
  let markerObserved = false;
  let synchronizationObserved = false;
  let synchronizationWindow = "";
  let resolveSynchronization!: () => void;
  const synchronizationPromise = new Promise<void>((resolveSynchronizationPromise) => {
    resolveSynchronization = resolveSynchronizationPromise;
  });

  const onData = (data: string): void => {
    const markerWindow = synchronizationWindow + data;
    synchronizationWindow = markerWindow.slice(-workload.synchronizationMarker.length);
    if (!markerObserved && markerWindow.includes(workload.synchronizationMarker)) {
      markerObserved = true;
      resolveSynchronization();
    }
    const bytes = Buffer.byteLength(data, "utf8");
    state.outputBytes += bytes;
    if (!state.connected) {
      state.detachedOutputBytes += bytes;
      return;
    }
    if (state.outputTruncated) return;
    if (state.storedBytes + bytes > TERMINAL_WORKLOAD_LIMITS.maxOutputBytes) {
      state.outputTruncated = true;
      return;
    }
    state.outputChunks.push(data);
    state.storedBytes += bytes;
  };
  const dataDisposable = pty.onData(onData);

  const remainingMs = (): number =>
    Math.max(0, TERMINAL_WORKLOAD_LIMITS.maxDurationMs - (Date.now() - startedAt));
  const boundedWait = async (durationMs: number): Promise<void> => {
    const budget = Math.min(durationMs, remainingMs());
    if (budget <= 0) return;
    await Promise.race([sleep(budget), exitPromise]);
  };
  const waitForSynchronization = async (): Promise<void> => {
    if (markerObserved) return;
    const budget = remainingMs();
    if (budget <= 0) return;
    await Promise.race([synchronizationPromise, sleep(budget)]);
  };

  try {
    await waitForSynchronization();
    synchronizationObserved = markerObserved;
    for (const step of workload.steps) {
      if (remainingMs() <= 0 || exited) break;
      switch (step.kind) {
        case "write":
          writeInput(pty, step.data);
          break;
        case "resize":
          pty.resize(step.dimensions.cols, step.dimensions.rows);
          resizeTrace.push({
            kind: "resize",
            cols: step.dimensions.cols,
            rows: step.dimensions.rows,
            elapsedMs: Date.now() - startedAt,
          });
          break;
        case "wait":
          await boundedWait(step.durationMs);
          break;
        case "disconnect":
          state.connected = false;
          break;
        case "reconnect":
          state.connected = true;
          break;
      }
    }

    if (!exited && workload.completion.input) writeInput(pty, workload.completion.input);
    if (!exited) await boundedWait(workload.completion.waitMs);
    if (!exited || workload.completion.terminateAfter) {
      killPty(pty, exited);
      await Promise.race([exitPromise, sleep(1_500)]);
    }
  } finally {
    dataDisposable.dispose();
    exitDisposable.dispose();
    if (!exited) killPty(pty, false);
  }

  const output = state.outputChunks.join("");
  const childPids = [...output.matchAll(/WF:cleanup:child:(\d+)/g)]
    .map((match) => Number(match[1]))
    .filter((pid, index, pids) => Number.isInteger(pid) && pids.indexOf(pid) === index);
  const childPidsAliveAfterKill = childPids.filter(isProcessAlive);
  const cleanupStartedAt = Date.now();
  const cleanupDeadline = cleanupStartedAt + TERMINAL_WORKLOAD_LIMITS.maxProcessLifetimeMs;
  for (const pid of childPidsAliveAfterKill) {
    await terminateProcess(pid, cleanupDeadline);
  }
  const childPidsAliveAfterCleanup = childPids.filter(isProcessAlive);

  const capture: TerminalWorkloadCapture = {
    output,
    outputBytes: state.outputBytes,
    outputTruncated: state.outputTruncated,
    detachedOutputBytes: state.detachedOutputBytes,
    resizeTrace,
    durationMs: Date.now() - startedAt,
    synchronizationObserved,
    exitObserved: exited,
    exitCode,
    childPids,
    childPidsAliveAfterKill,
    childPidsAliveAfterCleanup,
    cleanupDurationMs: Date.now() - cleanupStartedAt,
  };
  return evaluateTerminalWorkload(workload, capture);
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const results: TerminalWorkloadResult[] = [];
  for (const workload of options.workloads) {
    results.push(await runWorkload(workload, options.ptyMode));
  }
  const report = {
    platform: process.platform,
    runtime: process.release.name,
    ptyMode: options.ptyMode,
    limits: TERMINAL_WORKLOAD_LIMITS,
    results,
    passed: results.every((result) => result.passed),
  };
  await new Promise<void>((resolveWrite) => {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n", resolveWrite);
  });
  process.exit(report.passed ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
