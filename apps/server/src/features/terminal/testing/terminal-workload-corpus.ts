import { createHash } from "node:crypto";

/** Stable workload identifiers used by the terminal comparison corpus. */
export const TERMINAL_WORKLOAD_IDS = [
  "wrong-width-restoration",
  "jagged-reflow",
  "shaky-live-resizing",
  "bottom-row-clipping",
  "high-output-pressure",
  "reconnect-recovery",
  "interactive-program",
  "process-cleanup",
] as const;

/** A workload identifier from {@link TERMINAL_WORKLOAD_IDS}. */
export type TerminalWorkloadId = (typeof TERMINAL_WORKLOAD_IDS)[number];

/** Shared safety limits for every corpus run. */
export const TERMINAL_WORKLOAD_LIMITS = Object.freeze({
  maxCols: 140,
  maxRows: 40,
  maxResizeCount: 12,
  minResizeIntervalMs: 10,
  maxOutputBytes: 128 * 1024,
  maxDurationMs: 2_000,
  maxReplayBytes: 32 * 1024,
  maxProcessLifetimeMs: 3_000,
});

interface TerminalDimensions {
  readonly cols: number;
  readonly rows: number;
}

/** A deterministic input, resize, wait, or transport transition in a workload. */
export type TerminalWorkloadStep =
  | { readonly kind: "write"; readonly data: string }
  | { readonly kind: "resize"; readonly dimensions: TerminalDimensions }
  | { readonly kind: "wait"; readonly durationMs: number }
  | { readonly kind: "disconnect" }
  | { readonly kind: "reconnect" };

interface NodeProgram {
  readonly executable: "node";
  readonly source: string;
}

interface WorkloadCompletion {
  readonly input?: string;
  readonly waitMs: number;
  readonly terminateAfter?: boolean;
}

/** One bounded scenario, including its program, operation trace, and facts. */
export interface TerminalWorkloadSpec {
  readonly id: TerminalWorkloadId;
  readonly name: string;
  readonly purpose: string;
  readonly synchronizationMarker: string;
  readonly expectedResizeCount: number;
  readonly initialDimensions: TerminalDimensions;
  readonly program: NodeProgram;
  readonly steps: readonly TerminalWorkloadStep[];
  readonly expectedMarkers: readonly string[];
  readonly expectedFacts: readonly string[];
  readonly completion: WorkloadCompletion;
}

/** A single resize observed by a corpus consumer. */
export interface TerminalResizeObservation {
  readonly kind: "initial" | "resize";
  readonly cols: number;
  readonly rows: number;
  readonly elapsedMs: number;
}

/** Captured bytes and lifecycle facts supplied to the pure result evaluator. */
export interface TerminalWorkloadCapture {
  readonly output: string;
  readonly outputBytes: number;
  readonly outputTruncated: boolean;
  readonly detachedOutputBytes: number;
  readonly resizeTrace: readonly TerminalResizeObservation[];
  readonly durationMs: number;
  readonly synchronizationObserved: boolean;
  readonly exitObserved: boolean;
  readonly exitCode: number | null;
  readonly childPids: readonly number[];
  readonly childPidsAliveAfterKill: readonly number[];
  readonly childPidsAliveAfterCleanup: readonly number[];
  readonly cleanupDurationMs: number;
}

/** Structured result that later renderer and lifecycle tickets can compare. */
export interface TerminalWorkloadResult {
  readonly id: TerminalWorkloadId;
  readonly passed: boolean;
  readonly outputBytes: number;
  readonly detachedOutputBytes: number;
  readonly outputTruncated: boolean;
  readonly outputSha256: string;
  readonly normalizedOutputSha256: string;
  readonly durationMs: number;
  readonly synchronizationObserved: boolean;
  readonly exitObserved: boolean;
  readonly resizeTrace: readonly TerminalResizeObservation[];
  readonly observedMarkers: readonly string[];
  readonly missingMarkers: readonly string[];
  readonly childPids: readonly number[];
  readonly childPidsAliveAfterKill: readonly number[];
  readonly childPidsAliveAfterCleanup: readonly number[];
  readonly cleanupDurationMs: number;
  readonly failedChecks: readonly string[];
  readonly facts: readonly string[];
}

const WRONG_WIDTH_PROGRAM = String.raw`
const e = "\x1b";
const fill = (width, label) => label + "·".repeat(Math.max(0, width - label.length));
process.stdout.write(e + "[2J" + e + "[H");
process.stdout.write("WF:wrong-width:initial\n");
process.stdout.write(fill(80, "W80:") + "\n");
process.stdout.write(e + "[24;1H" + "WF:wrong-width:bottom\n");
setTimeout(() => process.stdout.write("WF:wrong-width:restored\n"), 160);
setTimeout(() => process.exit(0), 280);
`;

const JAGGED_REFLOW_PROGRAM = String.raw`
const e = "\x1b";
const wide = "A界é🙂".repeat(40);
process.stdout.write(e + "[2J" + e + "[H" + "WF:jagged:begin\n");
process.stdout.write(wide + "\n");
let tick = 0;
const timer = setInterval(() => {
  process.stdout.write("WF:jagged:tick:" + tick + ":" + wide.slice(0, 120) + "\n");
  tick += 1;
}, 45);
setTimeout(() => { clearInterval(timer); process.stdout.write("WF:jagged:end\n"); process.exit(0); }, 320);
`;

const SHAKY_RESIZE_PROGRAM = String.raw`
const e = "\x1b";
let tick = 0;
const timer = setInterval(() => {
  process.stdout.write("WF:resize:tick:" + tick + ":" + e + "[38;5;" + (tick % 16) + "mresize\n");
  tick += 1;
}, 15);
setTimeout(() => { clearInterval(timer); process.stdout.write(e + "[0mWF:resize:end\n"); process.exit(0); }, 300);
`;

const BOTTOM_ROW_PROGRAM = String.raw`
const e = "\x1b";
process.stdout.write(e + "[2J" + e + "[1;1H" + "WF:bottom-row:top\n");
process.stdout.write(e + "[24;1H" + "WF:bottom-row:initial\n");
setTimeout(() => process.stdout.write(e + "[8;1H" + "WF:bottom-row:resized\n"), 80);
setTimeout(() => process.stdout.write("WF:bottom-row:end\n"), 180);
setTimeout(() => process.exit(0), 260);
`;

const HIGH_OUTPUT_PROGRAM = String.raw`
const payload = "0123456789abcdef".repeat(256);
process.stdout.write("WF:high-output:begin\n");
for (let index = 0; index < 20; index += 1) {
  process.stdout.write("WF:high-output:chunk:" + index + ":" + payload + "\n");
}
process.stdout.write("WF:high-output:end\n");
process.exit(0);
`;

const RECONNECT_PROGRAM = String.raw`
let pending = "";
process.stdout.write("WF:reconnect:before\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  pending += chunk;
  let newline = pending.search(/[\r\n]/);
  while (newline >= 0) {
    const line = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    if (pending.startsWith("\n")) pending = pending.slice(1);
    if (line === "gap") {
      setTimeout(() => process.stdout.write("WF:reconnect:middle\n"), 60);
      setTimeout(() => process.stdout.write("WF:reconnect:after\n"), 220);
      setTimeout(() => process.exit(0), 340);
    }
    newline = pending.search(/[\r\n]/);
  }
});
`;

const INTERACTIVE_PROGRAM = String.raw`
let pending = "";
process.stdout.write("WF:interactive:ready\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  pending += chunk;
  let newline = pending.search(/[\r\n]/);
  while (newline >= 0) {
    const line = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    if (pending.startsWith("\n")) pending = pending.slice(1);
    if (line === "ping") process.stdout.write("WF:interactive:pong\n");
    if (line === "exit") { process.stdout.write("WF:interactive:done\n"); process.exit(0); }
    newline = pending.search(/[\r\n]/);
  }
});
`;

const PROCESS_CLEANUP_PROGRAM = String.raw`
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
process.stdout.write("WF:cleanup:parent\n");
process.stdout.write("WF:cleanup:child:" + child.pid + "\n");
setInterval(() => {}, 1000);
`;

const initialDimensions = Object.freeze({ cols: 80, rows: 24 });

const CORPUS: readonly TerminalWorkloadSpec[] = [
  {
    id: "wrong-width-restoration",
    name: "Wrong-width restoration",
    purpose: "Emit cursor markers around an 80x24 to 120x24 to 80x24 resize trace.",
    synchronizationMarker: "WF:wrong-width:initial",
    expectedResizeCount: 2,
    initialDimensions,
    program: { executable: "node", source: WRONG_WIDTH_PROGRAM },
    steps: [
      { kind: "wait", durationMs: 40 },
      { kind: "resize", dimensions: { cols: 120, rows: 24 } },
      { kind: "wait", durationMs: 80 },
      { kind: "resize", dimensions: { cols: 80, rows: 24 } },
      { kind: "wait", durationMs: 180 },
    ],
    expectedMarkers: ["WF:wrong-width:initial", "WF:wrong-width:bottom", "WF:wrong-width:restored"],
    expectedFacts: [
      "The width trace is 80x24 → 120x24 → 80x24.",
      "The byte stream contains the bottom-row and post-restore markers for the 80→120→80 trace.",
    ],
    completion: { waitMs: 1_200 },
  },
  {
    id: "jagged-reflow",
    name: "Jagged reflow",
    purpose: "Exercise long wrapped lines with wide, combining, and emoji graphemes while width changes.",
    synchronizationMarker: "WF:jagged:begin",
    expectedResizeCount: 4,
    initialDimensions,
    program: { executable: "node", source: JAGGED_REFLOW_PROGRAM },
    steps: [
      { kind: "wait", durationMs: 35 },
      { kind: "resize", dimensions: { cols: 39, rows: 24 } },
      { kind: "wait", durationMs: 12 },
      { kind: "resize", dimensions: { cols: 40, rows: 24 } },
      { kind: "wait", durationMs: 12 },
      { kind: "resize", dimensions: { cols: 41, rows: 24 } },
      { kind: "wait", durationMs: 12 },
      { kind: "resize", dimensions: { cols: 40, rows: 24 } },
      { kind: "wait", durationMs: 280 },
    ],
    expectedMarkers: ["WF:jagged:begin", "WF:jagged:tick:", "WF:jagged:end"],
    expectedFacts: [
      "The stream contains wide, combining, and emoji graphemes in a 240-code-unit line.",
      "The resize trace crosses 39, 40, and 41 columns while output is active.",
    ],
    completion: { waitMs: 1_200 },
  },
  {
    id: "shaky-live-resizing",
    name: "Shaky live resizing",
    purpose: "Apply a bounded resize burst while ANSI-colored output arrives every 15ms.",
    synchronizationMarker: "WF:resize:tick:",
    expectedResizeCount: 6,
    initialDimensions,
    program: { executable: "node", source: SHAKY_RESIZE_PROGRAM },
    steps: [
      { kind: "wait", durationMs: 30 },
      { kind: "resize", dimensions: { cols: 100, rows: 30 } },
      { kind: "wait", durationMs: 15 },
      { kind: "resize", dimensions: { cols: 101, rows: 30 } },
      { kind: "wait", durationMs: 15 },
      { kind: "resize", dimensions: { cols: 99, rows: 29 } },
      { kind: "wait", durationMs: 15 },
      { kind: "resize", dimensions: { cols: 100, rows: 30 } },
      { kind: "wait", durationMs: 15 },
      { kind: "resize", dimensions: { cols: 98, rows: 28 } },
      { kind: "wait", durationMs: 15 },
      { kind: "resize", dimensions: { cols: 100, rows: 30 } },
      { kind: "wait", durationMs: 260 },
    ],
    expectedMarkers: ["WF:resize:tick:", "WF:resize:end"],
    expectedFacts: [
      "Six resizes occur while output is emitted at a 15ms cadence.",
      "The output includes SGR color changes and a reset sequence.",
    ],
    completion: { waitMs: 1_200 },
  },
  {
    id: "bottom-row-clipping",
    name: "Bottom-row clipping",
    purpose: "Write on the initial and resized last rows to expose clipping and scroll-off-by-one errors.",
    synchronizationMarker: "WF:bottom-row:initial",
    expectedResizeCount: 1,
    initialDimensions,
    program: { executable: "node", source: BOTTOM_ROW_PROGRAM },
    steps: [
      { kind: "wait", durationMs: 35 },
      { kind: "resize", dimensions: { cols: 100, rows: 8 } },
      { kind: "wait", durationMs: 220 },
    ],
    expectedMarkers: ["WF:bottom-row:top", "WF:bottom-row:initial", "WF:bottom-row:resized", "WF:bottom-row:end"],
    expectedFacts: [
      "The program addresses row 24 before resizing and row 8 after resizing.",
      "The final marker is emitted after the cursor returns from the bottom row.",
    ],
    completion: { waitMs: 1_200 },
  },
  {
    id: "high-output-pressure",
    name: "High-output pressure",
    purpose: "Produce a repeatable burst large enough to cross flow-control thresholds without unbounded output.",
    synchronizationMarker: "WF:high-output:begin",
    expectedResizeCount: 0,
    initialDimensions,
    program: { executable: "node", source: HIGH_OUTPUT_PROGRAM },
    steps: [{ kind: "wait", durationMs: 120 }],
    expectedMarkers: ["WF:high-output:begin", "WF:high-output:chunk:", "WF:high-output:end"],
    expectedFacts: [
      "The burst contains 20 numbered chunks of 4KiB payload plus framing.",
      "The complete capture remains below the 128KiB corpus cap.",
    ],
    completion: { waitMs: 1_200 },
  },
  {
    id: "reconnect-recovery",
    name: "Reconnect recovery",
    purpose: "Detach from a live PTY during output, then reattach and capture the post-gap marker.",
    synchronizationMarker: "WF:reconnect:before",
    expectedResizeCount: 0,
    initialDimensions,
    program: { executable: "node", source: RECONNECT_PROGRAM },
    steps: [
      { kind: "write", data: "gap\n" },
      { kind: "disconnect" },
      { kind: "wait", durationMs: 100 },
      { kind: "reconnect" },
      { kind: "wait", durationMs: 300 },
    ],
    expectedMarkers: ["WF:reconnect:before", "WF:reconnect:after"],
    expectedFacts: [
      "Bytes observed while detached are counted separately from attached bytes.",
      "The post-gap marker is received after reattachment without respawning the program.",
    ],
    completion: { waitMs: 1_200 },
  },
  {
    id: "interactive-program",
    name: "Interactive program",
    purpose: "Drive a real line-oriented child through the PTY and require a deterministic response.",
    synchronizationMarker: "WF:interactive:ready",
    expectedResizeCount: 0,
    initialDimensions,
    program: { executable: "node", source: INTERACTIVE_PROGRAM },
    steps: [
      { kind: "wait", durationMs: 40 },
      { kind: "write", data: "ping\n" },
      { kind: "wait", durationMs: 60 },
    ],
    expectedMarkers: ["WF:interactive:ready", "WF:interactive:pong", "WF:interactive:done"],
    expectedFacts: [
      "Input travels through the PTY line discipline and produces PONG.",
      "The program exits only after the explicit exit input.",
    ],
    completion: { input: "exit\n", waitMs: 1_200 },
  },
  {
    id: "process-cleanup",
    name: "Process cleanup",
    purpose: "Spawn a child from a PTY-owned parent and verify that termination leaves no child behind.",
    synchronizationMarker: "WF:cleanup:parent",
    expectedResizeCount: 0,
    initialDimensions,
    program: { executable: "node", source: PROCESS_CLEANUP_PROGRAM },
    steps: [{ kind: "wait", durationMs: 120 }],
    expectedMarkers: ["WF:cleanup:parent", "WF:cleanup:child:"],
    expectedFacts: [
      "The child PID is reported by the real PTY process, not a mock.",
      "The process-tree check records whether the child remains alive after PTY termination.",
    ],
    completion: { waitMs: 120, terminateAfter: true },
  },
] as const;

/** Return all corpus scenarios in their stable comparison order. */
export function listTerminalWorkloads(): readonly TerminalWorkloadSpec[] {
  return CORPUS;
}

/** Resolve one workload id through the explicit allowlist. */
export function getTerminalWorkload(id: string): TerminalWorkloadSpec {
  const workload = CORPUS.find((candidate) => candidate.id === id);
  if (!workload) throw new Error(`Unknown terminal workload: ${id}`);
  return workload;
}

/** Normalize platform line endings and volatile child PIDs before comparison. */
export function normalizeTerminalWorkloadOutput(output: string): string {
  return output
    .replace(/\r\n?/g, "\n")
    .replace(/\u001b\]0;[^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/WF:cleanup:child:\d+/g, "WF:cleanup:child:<pid>");
}

/** Evaluate one captured run against its bounded scenario contract. */
export function evaluateTerminalWorkload(
  workload: TerminalWorkloadSpec,
  capture: TerminalWorkloadCapture,
): TerminalWorkloadResult {
  const outputSha256 = createHash("sha256").update(capture.output, "utf8").digest("hex");
  const normalizedOutput = normalizeTerminalWorkloadOutput(capture.output);
  const normalizedOutputSha256 = createHash("sha256")
    .update(normalizedOutput, "utf8")
    .digest("hex");
  const observedMarkers = workload.expectedMarkers.filter((marker) => capture.output.includes(marker));
  const missingMarkers = workload.expectedMarkers.filter((marker) => !capture.output.includes(marker));
  const resizeCount = capture.resizeTrace.filter((resize) => resize.kind === "resize").length;
  const failedChecks: string[] = [];

  appendCaptureFailures(workload, capture, missingMarkers, failedChecks);
  appendResizeFailures(workload, capture, resizeCount, failedChecks);
  appendCleanupFailures(workload, capture, failedChecks);

  const facts = [
    ...workload.expectedFacts,
    "cleanup: " +
      capture.cleanupDurationMs +
      "ms, remaining children after cleanup: " +
      capture.childPidsAliveAfterCleanup.length,
    `observed output: ${capture.outputBytes} bytes (${capture.detachedOutputBytes} detached)`,
    `observed resizes: ${resizeCount}`,
    `normalized output sha256: ${normalizedOutputSha256}`,
  ];

  return {
    id: workload.id,
    passed: failedChecks.length === 0,
    outputBytes: capture.outputBytes,
    detachedOutputBytes: capture.detachedOutputBytes,
    outputTruncated: capture.outputTruncated,
    outputSha256,
    normalizedOutputSha256,
    durationMs: capture.durationMs,
    synchronizationObserved: capture.synchronizationObserved,
    exitObserved: capture.exitObserved,
    resizeTrace: capture.resizeTrace,
    observedMarkers,
    missingMarkers,
    childPids: capture.childPids,
    childPidsAliveAfterKill: capture.childPidsAliveAfterKill,
    childPidsAliveAfterCleanup: capture.childPidsAliveAfterCleanup,
    cleanupDurationMs: capture.cleanupDurationMs,
    failedChecks,
    facts,
  };
}

function appendCaptureFailures(
  workload: TerminalWorkloadSpec,
  capture: TerminalWorkloadCapture,
  missingMarkers: readonly string[],
  failedChecks: string[],
): void {
  if (missingMarkers.length > 0) failedChecks.push(`missing markers: ${missingMarkers.join(", ")}`);
  if (capture.outputTruncated || capture.outputBytes > TERMINAL_WORKLOAD_LIMITS.maxOutputBytes) {
    failedChecks.push("output exceeded the bounded capture");
  }
  if (capture.durationMs > TERMINAL_WORKLOAD_LIMITS.maxDurationMs) {
    failedChecks.push("workload exceeded its duration budget");
  }
  if (!capture.synchronizationObserved) {
    failedChecks.push("synchronization marker was not observed before workload steps");
  }
  if (!capture.exitObserved) failedChecks.push("terminal exit was not observed");
  if (!workload.completion.terminateAfter && capture.exitCode !== 0) {
    failedChecks.push("unexpected terminal exit code: " + String(capture.exitCode));
  }
}

function appendResizeFailures(
  workload: TerminalWorkloadSpec,
  capture: TerminalWorkloadCapture,
  resizeCount: number,
  failedChecks: string[],
): void {
  if (resizeCount > TERMINAL_WORKLOAD_LIMITS.maxResizeCount) {
    failedChecks.push("resize count exceeded the corpus limit");
  }
  if (resizeCount !== workload.expectedResizeCount) {
    failedChecks.push(
      `resize count drifted from the declared plan (${workload.expectedResizeCount} expected, ${resizeCount} observed)`,
    );
  }
  if (hasResizeIntervalBelowLimit(capture)) {
    failedChecks.push("resize interval was below the corpus rate limit");
  }
}

function hasResizeIntervalBelowLimit(capture: TerminalWorkloadCapture): boolean {
  const resizeTimes = capture.resizeTrace
    .filter((resize) => resize.kind === "resize")
    .map((resize) => resize.elapsedMs);
  return resizeTimes.some(
    (time, index) =>
      index > 0 && time - resizeTimes[index - 1]! < TERMINAL_WORKLOAD_LIMITS.minResizeIntervalMs,
  );
}

function appendCleanupFailures(
  workload: TerminalWorkloadSpec,
  capture: TerminalWorkloadCapture,
  failedChecks: string[],
): void {
  if (capture.detachedOutputBytes > TERMINAL_WORKLOAD_LIMITS.maxReplayBytes) {
    failedChecks.push("detached output exceeded the replay evidence bound");
  }
  if (workload.id === "reconnect-recovery" && capture.detachedOutputBytes === 0) {
    failedChecks.push("reconnect captured no detached output");
  }
  if (capture.cleanupDurationMs > TERMINAL_WORKLOAD_LIMITS.maxProcessLifetimeMs) {
    failedChecks.push("process cleanup exceeded its lifetime bound");
  }
  if (capture.childPidsAliveAfterKill.length > 0) {
    failedChecks.push("child processes remained alive after PTY termination");
  }
  if (capture.childPidsAliveAfterCleanup.length > 0) {
    failedChecks.push("child processes remained alive after cleanup escalation");
  }
}
