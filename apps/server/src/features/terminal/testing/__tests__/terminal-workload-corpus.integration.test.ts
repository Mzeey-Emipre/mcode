import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface CliRun {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(TEST_DIRECTORY, "../../../../../../..");
const CORPUS_SCRIPT = resolve(REPOSITORY_ROOT, "apps/server/scripts/run-terminal-workload-corpus.ts");
const VITE_NODE_CLI = resolve(
  dirname(createRequire(import.meta.url).resolve("vite-node/package.json")),
  "dist/cli.mjs",
);

function runWorkload(workloadId: string): Promise<CliRun> {
  const executable = process.platform === "win32" ? "node.exe" : "node";
  const ptyModeArgs = process.platform === "win32" ? ["--windows-pty", "native"] : [];
  const child = spawn(
    executable,
    [
      VITE_NODE_CLI,
      "--root",
      resolve(REPOSITORY_ROOT, "apps/server"),
      CORPUS_SCRIPT,
      "--workload",
      workloadId,
      ...ptyModeArgs,
      "--json",
    ],
    {
      cwd: REPOSITORY_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );

  return new Promise((resolveRun, rejectRun) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 12_000);

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectRun(error);
    });
    child.once("close", (status, signal) => {
      clearTimeout(timeout);
      resolveRun({ status, signal, stdout, stderr, timedOut });
    });
  });
}

describe("terminal workload corpus CLI integration", () => {
  it("runs the bounded high-output workload and exits without a runner timeout", async () => {
    const run = await runWorkload("high-output-pressure");

    expect(run.timedOut).toBe(false);
    expect(run.signal).toBeNull();
    expect(run.status, run.stderr || run.stdout).toBe(0);
    const report = JSON.parse(run.stdout) as {
      readonly passed: boolean;
      readonly ptyMode: string;
      readonly results: readonly [{ readonly outputBytes: number; readonly outputTruncated: boolean }];
    };
    expect(report.passed).toBe(true);
    expect(report.ptyMode).toBe(process.platform === "win32" ? "native" : "platform-default");
    expect(report.results[0]?.outputBytes).toBeGreaterThan(80_000);
    expect(report.results[0]?.outputTruncated).toBe(false);
  }, 20_000);

  it("waits for the bottom-row marker before applying its resize", async () => {
    const run = await runWorkload("bottom-row-clipping");

    expect(run.timedOut).toBe(false);
    expect(run.signal).toBeNull();
    expect(run.status, run.stderr || run.stdout).toBe(0);
    const report = JSON.parse(run.stdout) as {
      readonly passed: boolean;
      readonly results: readonly [{
        readonly synchronizationObserved: boolean;
        readonly resizeTrace: readonly [{ readonly kind: string }, { readonly kind: string }];
      }];
    };
    expect(report.passed).toBe(true);
    expect(report.results[0]?.synchronizationObserved).toBe(true);
    expect(report.results[0]?.resizeTrace[1]?.kind).toBe("resize");
  }, 20_000);
});
