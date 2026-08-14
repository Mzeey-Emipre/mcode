import { describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateTerminalWorkload,
  getTerminalWorkload,
  listTerminalWorkloads,
  normalizeTerminalWorkloadOutput,
  TERMINAL_WORKLOAD_IDS,
  TERMINAL_WORKLOAD_LIMITS,
  type TerminalWorkloadCapture,
} from "../terminal-workload-corpus.js";

async function waitForCleanupMarkers(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<string> {
  let output = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { output += chunk; });
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  const markers = [
    "WF:cleanup:parent:",
    "WF:cleanup:child:",
    "WF:cleanup:grandchild:",
  ];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (markers.every((marker) => output.includes(marker))) return output;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Process cleanup markers timed out: " + JSON.stringify({ output, stderr }));
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function terminateProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 3_000,
      });
    } catch {
      if (processIsAlive(pid)) throw new Error("Could not terminate process tree " + pid);
    }
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    if (processIsAlive(pid)) throw new Error("Could not terminate process group " + pid);
  }
}

async function waitForProcessTreeExit(pids: readonly number[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !processIsAlive(pid))) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const alive = pids.filter(processIsAlive);
  if (alive.length > 0) throw new Error("Process cleanup left PIDs alive: " + alive.join(","));
}

describe("terminal workload corpus", () => {
  it("contains each named failure family in a stable order", () => {
    expect(listTerminalWorkloads().map((workload) => workload.id)).toEqual([...TERMINAL_WORKLOAD_IDS]);
    expect(new Set(listTerminalWorkloads().map((workload) => workload.id)).size).toBe(8);
  });

  it("keeps every fixture within the shared dimensions, resize, and wait bounds", () => {
    for (const workload of listTerminalWorkloads()) {
      expect(workload.initialDimensions.cols).toBeLessThanOrEqual(TERMINAL_WORKLOAD_LIMITS.maxCols);
      expect(workload.initialDimensions.rows).toBeLessThanOrEqual(TERMINAL_WORKLOAD_LIMITS.maxRows);
      const resizeSteps = workload.steps.filter((step) => step.kind === "resize");
      expect(resizeSteps.length).toBeLessThanOrEqual(TERMINAL_WORKLOAD_LIMITS.maxResizeCount);
      for (const step of resizeSteps) {
        if (step.kind !== "resize") continue;
        expect(step.dimensions.cols).toBeGreaterThan(0);
        expect(step.dimensions.cols).toBeLessThanOrEqual(TERMINAL_WORKLOAD_LIMITS.maxCols);
        expect(step.dimensions.rows).toBeGreaterThan(0);
        expect(step.dimensions.rows).toBeLessThanOrEqual(TERMINAL_WORKLOAD_LIMITS.maxRows);
      }
      for (const step of workload.steps) {
        if (step.kind === "wait") {
          expect(step.durationMs).toBeGreaterThanOrEqual(0);
          expect(step.durationMs).toBeLessThanOrEqual(TERMINAL_WORKLOAD_LIMITS.maxDurationMs);
        }
      }
    }
  });

  it("keeps declared resize counts and synchronization markers aligned with each plan", () => {
    for (const workload of listTerminalWorkloads()) {
      const resizeCount = workload.steps.filter((step) => step.kind === "resize").length;
      expect(workload.expectedResizeCount).toBe(resizeCount);
      expect(workload.synchronizationMarker.length).toBeGreaterThan(0);
      expect(workload.expectedMarkers).toContain(workload.synchronizationMarker);
    }
    expect(getTerminalWorkload("shaky-live-resizing").expectedResizeCount).toBe(6);
  });

  it("gives process cleanup the bounded duration needed for descendant markers", () => {
    expect(getTerminalWorkload("process-cleanup").completion.waitMs).toBe(
      TERMINAL_WORKLOAD_LIMITS.maxDurationMs,
    );
  });

  it("executes process cleanup with three distinct PIDs and cleans up descendants", async () => {
    const workload = getTerminalWorkload("process-cleanup");
    const root = mkdtempSync(join(tmpdir(), "mcode-process-cleanup-"));
    const scriptPath = join(root, "process-cleanup.cjs");
    writeFileSync(scriptPath, workload.program.source, "utf8");
    const child = spawn(process.execPath, [scriptPath], {
      cwd: root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    if (!child.pid) throw new Error("Process cleanup child PID is missing");
    const rootPid = child.pid;
    let pids = [rootPid];
    try {
      const output = await waitForCleanupMarkers(child, workload.completion.waitMs);
      const markerPids = [
        /WF:cleanup:parent:(\d+)/.exec(output)?.[1],
        /WF:cleanup:child:(\d+)/.exec(output)?.[1],
        /WF:cleanup:grandchild:(\d+)/.exec(output)?.[1],
      ].map((pid) => Number(pid));
      expect(markerPids.every((pid) => Number.isSafeInteger(pid) && pid > 0)).toBe(true);
      expect(new Set(markerPids).size).toBe(3);
      pids = [...new Set([rootPid, ...markerPids])];
    } finally {
      terminateProcessTree(rootPid);
      await waitForProcessTreeExit(pids, TERMINAL_WORKLOAD_LIMITS.maxProcessLifetimeMs);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("normalizes platform line endings and volatile child IDs for renderer comparison", () => {
    expect(normalizeTerminalWorkloadOutput("a\r\nb\rWF:cleanup:child:1234\n")).toBe(
      "a\nb\nWF:cleanup:child:<pid>\n",
    );
  });

  it("evaluates complete captures and reports the facts later tickets need", () => {
    const workload = getTerminalWorkload("reconnect-recovery");
    const capture: TerminalWorkloadCapture = {
      output: "WF:reconnect:before\nWF:reconnect:after\n",
      outputBytes: 40,
      outputTruncated: false,
      detachedOutputBytes: 21,
      resizeTrace: [{ kind: "initial", cols: 80, rows: 24, elapsedMs: 0 }],
      durationMs: 120,
      synchronizationObserved: true,
      exitObserved: true,
      exitCode: 0,
      childPids: [],
      childPidsAliveAfterKill: [],
      childPidsAliveAfterCleanup: [],
      cleanupDurationMs: 0,
    };

    const result = evaluateTerminalWorkload(workload, capture);

    expect(result.passed).toBe(true);
    expect(result.missingMarkers).toEqual([]);
    expect(result.detachedOutputBytes).toBe(21);
    expect(result.normalizedOutputSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.facts).toEqual(expect.arrayContaining([
      expect.stringContaining("post-gap marker"),
      expect.stringContaining("40 bytes"),
    ]));
  });

  it("fails a capture that exceeds the byte budget or leaves a child alive", () => {
    const workload = getTerminalWorkload("process-cleanup");
    const capture: TerminalWorkloadCapture = {
      output: "WF:cleanup:parent\nWF:cleanup:child:42\n",
      outputBytes: TERMINAL_WORKLOAD_LIMITS.maxOutputBytes + 1,
      outputTruncated: true,
      detachedOutputBytes: 0,
      resizeTrace: [{ kind: "initial", cols: 80, rows: 24, elapsedMs: 0 }],
      durationMs: 50,
      synchronizationObserved: true,
      exitObserved: true,
      exitCode: null,
      childPids: [42],
      childPidsAliveAfterKill: [42],
      childPidsAliveAfterCleanup: [],
      cleanupDurationMs: 0,
    };

    const result = evaluateTerminalWorkload(workload, capture);

    expect(result.passed).toBe(false);
    expect(result.failedChecks).toEqual(expect.arrayContaining([
      "output exceeded the bounded capture",
      "child processes remained alive after PTY termination",
    ]));
  });

  it("fails a capture when its synchronization marker was not observed", () => {
    const workload = getTerminalWorkload("high-output-pressure");
    const result = evaluateTerminalWorkload(workload, {
      output: "WF:high-output:begin\nWF:high-output:chunk:0\nWF:high-output:end\n",
      outputBytes: 64,
      outputTruncated: false,
      detachedOutputBytes: 0,
      resizeTrace: [{ kind: "initial", cols: 80, rows: 24, elapsedMs: 0 }],
      durationMs: 100,
      synchronizationObserved: false,
      exitObserved: true,
      exitCode: 0,
      childPids: [],
      childPidsAliveAfterKill: [],
      childPidsAliveAfterCleanup: [],
      cleanupDurationMs: 0,
    });

    expect(result.failedChecks).toContain(
      "synchronization marker was not observed before workload steps",
    );
  });
});
