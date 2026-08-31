#!/usr/bin/env node
import { spawn } from "node-pty";
import type { IPty } from "node-pty";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
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

const REPO_ROOT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../../..");

function resolveNodeExecutable(): string {
  if (!/[\\/]bun(?:\.exe)?$/i.test(process.execPath)) return process.execPath;
  const resolver = process.platform === "win32" ? "where.exe" : "which";
  const output = NodeChildProcess.execFileSync(resolver, ["node"], {
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
  const { ids, windowsPtyMode } = parseCliArguments(args);
  return {
    workloads: resolveWorkloads(ids),
    ptyMode: resolvePtyMode(windowsPtyMode),
  };
}

function parseCliArguments(args: readonly string[]): {
  readonly ids: TerminalWorkloadId[];
  readonly windowsPtyMode: WindowsPtyMode | undefined;
} {
  let windowsPtyMode: WindowsPtyMode | undefined;
  const ids: TerminalWorkloadId[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") continue;
    const ptyOption = parseWindowsPtyOption(args, index);
    if (ptyOption) {
      windowsPtyMode = ptyOption.mode;
      index = ptyOption.nextIndex;
      continue;
    }
    const workloadOption = parseWorkloadOption(args, index);
    ids.push(workloadOption.id);
    index = workloadOption.nextIndex;
  }
  return { ids, windowsPtyMode };
}

function parseWindowsPtyOption(
  args: readonly string[],
  index: number,
): { readonly mode: WindowsPtyMode; readonly nextIndex: number } | null {
  if (args[index] !== "--windows-pty") return null;
  if (process.platform !== "win32") throw new Error("--windows-pty is only supported on Windows");
  const mode = args[index + 1];
  if (mode !== "mcode" && mode !== "native") throw new Error("--windows-pty expects mcode or native");
  return { mode, nextIndex: index + 1 };
}

function parseWorkloadOption(
  args: readonly string[],
  index: number,
): { readonly id: TerminalWorkloadId; readonly nextIndex: number } {
  const id = args[index + 1];
  if (args[index] !== "--workload" || !id) throw new Error("Unknown argument: " + args[index]);
  if (!TERMINAL_WORKLOAD_IDS.includes(id as TerminalWorkloadId)) {
    throw new Error("Unknown terminal workload: " + id);
  }
  return { id: id as TerminalWorkloadId, nextIndex: index + 1 };
}

function resolveWorkloads(ids: readonly TerminalWorkloadId[]): readonly TerminalWorkloadSpec[] {
  return ids.length > 0 ? ids.map((id) => getTerminalWorkload(id)) : [...listTerminalWorkloads()];
}

function resolvePtyMode(windowsPtyMode: WindowsPtyMode | undefined): TerminalPtyMode {
  return process.platform === "win32" ? (windowsPtyMode ?? "mcode") : "platform-default";
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

interface PtyExitState {
  exited: boolean;
  exitCode: number | null;
}

interface SynchronizationState {
  markerObserved: boolean;
  markerWindow: string;
  readonly signal: () => void;
}

interface WorkloadRuntime {
  readonly startedAt: number;
  readonly workload: TerminalWorkloadSpec;
  readonly pty: IPty;
  readonly captureState: CaptureState;
  readonly resizeTrace: TerminalResizeObservation[];
  readonly exitState: PtyExitState;
  readonly exitPromise: Promise<void>;
  readonly exitDisposable: { dispose(): void };
  readonly synchronizationState: SynchronizationState;
  readonly synchronizationPromise: Promise<void>;
  synchronizationObserved: boolean;
  readonly dataDisposable: { dispose(): void };
}

function createPtyExitState(): {
  readonly state: PtyExitState;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolveExit!: () => void;
  const promise = new Promise<void>((resolveExitPromise) => {
    resolveExit = resolveExitPromise;
  });
  return { state: { exited: false, exitCode: null }, promise, resolve: resolveExit };
}

function createSynchronizationState(): {
  readonly state: SynchronizationState;
  readonly promise: Promise<void>;
} {
  let resolveSynchronization!: () => void;
  const promise = new Promise<void>((resolveSynchronizationPromise) => {
    resolveSynchronization = resolveSynchronizationPromise;
  });
  return {
    state: {
      markerObserved: false,
      markerWindow: "",
      signal: resolveSynchronization,
    },
    promise,
  };
}

function createWorkloadEnvironment(): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  environment.MCODE_TERMINAL_CORPUS = "1";
  return environment;
}

function createPtyOptions(workload: TerminalWorkloadSpec, ptyMode: TerminalPtyMode) {
  return {
    name: "xterm-256color",
    cols: workload.initialDimensions.cols,
    rows: workload.initialDimensions.rows,
    cwd: REPO_ROOT,
    env: createWorkloadEnvironment(),
    ...(process.platform === "win32" && ptyMode === "mcode" ? { useConptyDll: true } : {}),
    ...(process.platform === "win32" && ptyMode === "native" ? { useConpty: true } : {}),
  };
}

function observeSynchronization(
  data: string,
  synchronization: SynchronizationState,
  marker: string,
): void {
  const markerWindow = synchronization.markerWindow + data;
  synchronization.markerWindow = markerWindow.slice(-marker.length);
  if (!synchronization.markerObserved && markerWindow.includes(marker)) {
    synchronization.markerObserved = true;
    synchronization.signal();
  }
}

function capturePtyOutput(data: string, state: CaptureState): void {
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
}

function createWorkloadRuntime(
  workload: TerminalWorkloadSpec,
  ptyMode: TerminalPtyMode,
): WorkloadRuntime {
  const startedAt = Date.now();
  const captureState: CaptureState = {
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
  const pty = spawn(NODE_EXECUTABLE, ["-e", workload.program.source], createPtyOptions(workload, ptyMode));
  const exit = createPtyExitState();
  const exitDisposable = pty.onExit(({ exitCode }) => {
    exit.state.exited = true;
    exit.state.exitCode = exitCode;
    exit.resolve();
  });
  const synchronization = createSynchronizationState();
  const dataDisposable = pty.onData((data) => {
    observeSynchronization(data, synchronization.state, workload.synchronizationMarker);
    capturePtyOutput(data, captureState);
  });
  return {
    startedAt,
    workload,
    pty,
    captureState,
    resizeTrace,
    exitState: exit.state,
    exitPromise: exit.promise,
    exitDisposable,
    synchronizationState: synchronization.state,
    synchronizationPromise: synchronization.promise,
    synchronizationObserved: false,
    dataDisposable,
  };
}

function remainingDuration(runtime: WorkloadRuntime): number {
  return Math.max(0, TERMINAL_WORKLOAD_LIMITS.maxDurationMs - (Date.now() - runtime.startedAt));
}

async function waitForPtyOrDuration(runtime: WorkloadRuntime, durationMs: number): Promise<void> {
  const budget = Math.min(durationMs, remainingDuration(runtime));
  if (budget <= 0) return;
  await Promise.race([sleep(budget), runtime.exitPromise]);
}

async function waitForSynchronization(runtime: WorkloadRuntime): Promise<void> {
  if (runtime.synchronizationState.markerObserved) return;
  const budget = remainingDuration(runtime);
  if (budget <= 0) return;
  await Promise.race([runtime.synchronizationPromise, sleep(budget)]);
}

function applyWorkloadStep(runtime: WorkloadRuntime, step: TerminalWorkloadSpec["steps"][number]): Promise<void> | void {
  switch (step.kind) {
    case "write":
      writeInput(runtime.pty, step.data);
      return;
    case "resize":
      runtime.pty.resize(step.dimensions.cols, step.dimensions.rows);
      runtime.resizeTrace.push({
        kind: "resize",
        cols: step.dimensions.cols,
        rows: step.dimensions.rows,
        elapsedMs: Date.now() - runtime.startedAt,
      });
      return;
    case "wait":
      return waitForPtyOrDuration(runtime, step.durationMs);
    case "disconnect":
      runtime.captureState.connected = false;
      return;
    case "reconnect":
      runtime.captureState.connected = true;
  }
}

async function runWorkloadSteps(runtime: WorkloadRuntime): Promise<void> {
  await waitForSynchronization(runtime);
  runtime.synchronizationObserved = runtime.synchronizationState.markerObserved;
  const { exitState, workload } = runtime;
  for (const step of workload.steps) {
    if (remainingDuration(runtime) <= 0 || exitState.exited) break;
    await applyWorkloadStep(runtime, step);
  }
}

async function completeWorkload(runtime: WorkloadRuntime): Promise<void> {
  const { exitState, pty, workload } = runtime;
  if (!exitState.exited && workload.completion.input) writeInput(pty, workload.completion.input);
  if (!exitState.exited) await waitForPtyOrDuration(runtime, workload.completion.waitMs);
  if (!exitState.exited || workload.completion.terminateAfter) {
    killPty(pty, exitState.exited);
    await Promise.race([runtime.exitPromise, sleep(1_500)]);
  }
}

function disposeWorkloadRuntime(runtime: WorkloadRuntime): void {
  runtime.dataDisposable.dispose();
  runtime.exitDisposable.dispose();
  if (!runtime.exitState.exited) killPty(runtime.pty, false);
}

function extractChildPids(output: string): number[] {
  return [...output.matchAll(/WF:cleanup:child:(\d+)/g)]
    .map((match) => Number(match[1]))
    .filter((pid, index, pids) => Number.isInteger(pid) && pids.indexOf(pid) === index);
}

async function cleanUpChildProcesses(childPids: readonly number[]): Promise<{
  readonly childPidsAliveAfterKill: number[];
  readonly childPidsAliveAfterCleanup: number[];
  readonly cleanupDurationMs: number;
}> {
  const childPidsAliveAfterKill = childPids.filter(isProcessAlive);
  const cleanupStartedAt = Date.now();
  const cleanupDeadline = cleanupStartedAt + TERMINAL_WORKLOAD_LIMITS.maxProcessLifetimeMs;
  for (const pid of childPidsAliveAfterKill) await terminateProcess(pid, cleanupDeadline);
  return {
    childPidsAliveAfterKill,
    childPidsAliveAfterCleanup: childPids.filter(isProcessAlive),
    cleanupDurationMs: Date.now() - cleanupStartedAt,
  };
}

async function runWorkload(
  workload: TerminalWorkloadSpec,
  ptyMode: TerminalPtyMode,
): Promise<TerminalWorkloadResult> {
  const runtime = createWorkloadRuntime(workload, ptyMode);

  try {
    await runWorkloadSteps(runtime);
    await completeWorkload(runtime);
  } finally {
    disposeWorkloadRuntime(runtime);
  }

  const output = runtime.captureState.outputChunks.join("");
  const childPids = extractChildPids(output);
  const cleanup = await cleanUpChildProcesses(childPids);

  const capture: TerminalWorkloadCapture = {
    output,
    outputBytes: runtime.captureState.outputBytes,
    outputTruncated: runtime.captureState.outputTruncated,
    detachedOutputBytes: runtime.captureState.detachedOutputBytes,
    resizeTrace: runtime.resizeTrace,
    durationMs: Date.now() - runtime.startedAt,
    synchronizationObserved: runtime.synchronizationObserved,
    exitObserved: runtime.exitState.exited,
    exitCode: runtime.exitState.exitCode,
    childPids,
    ...cleanup,
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
