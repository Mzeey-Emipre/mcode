import { summarizeDurationSamples } from "./frontend-performance-collectors.mjs";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodePath from "node:path";

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);

/** Matches an operator classification to one adapter reported by Windows. */
export function resolveWindowsGpuClassification(devices, adapterName, gpuType) {
  const matchingAdapter = devices.find(
    (device) =>
      typeof device.name === "string" &&
      device.name.localeCompare(adapterName, undefined, { sensitivity: "accent" }) === 0,
  );
  if (!matchingAdapter) {
    throw new Error(`Requested adapter was not reported by Windows: ${adapterName}`);
  }
  return {
    type: gpuType,
    source: "operator-declared-for-matched-windows-adapter",
    adapterName: matchingAdapter.name,
  };
}

function summarizePercentSamples(values) {
  const summary = summarizeDurationSamples(values);
  return summary
    ? {
        sampleCount: summary.sampleCount,
        minPercent: summary.minMs,
        medianPercent: summary.medianMs,
        p95Percent: summary.p95Ms,
        maxPercent: summary.maxMs,
      }
    : null;
}

/** Summarizes attributable Windows GPU Engine samples by Electron process. */
export function summarizeWindowsGpuEngineSamples(samples, expectedPids) {
  const descriptors = new Map(
    expectedPids.map((process) => [
      typeof process === "number" ? process : process.pid,
      typeof process === "number" ? { pid: process } : process,
    ]),
  );
  const allowedPids = new Set(descriptors.keys());
  const attributable = samples.filter(
    (sample) =>
      allowedPids.has(sample.pid) &&
      Number.isFinite(sample.valuePercent) &&
      sample.valuePercent >= 0,
  );
  if (attributable.length === 0) {
    return {
      status: "inconclusive",
      reason: "No attributable GPU Engine counter samples were returned",
      processes: [],
    };
  }

  const grouped = new Map();
  for (const sample of attributable) {
    const timestamps = grouped.get(sample.pid) ?? new Map();
    timestamps.set(
      sample.timestamp,
      Math.max(timestamps.get(sample.timestamp) ?? 0, sample.valuePercent),
    );
    grouped.set(sample.pid, timestamps);
  }
  const processes = [...grouped.entries()]
    .sort(([left], [right]) => left - right)
    .map(([pid, timestamps]) => ({
      ...descriptors.get(pid),
      busiestEngine: summarizePercentSamples([...timestamps.values()]),
    }));
  const active = attributable.some((sample) => sample.valuePercent > 0);
  return {
    status: active ? "active" : "inconclusive",
    reason: active
      ? null
      : "Attributable GPU Engine samples were zero during the controlled workload",
    processes,
  };
}

/** Samples Windows GPU Engine counters for the supplied Electron processes. */
export async function collectWindowsGpuEngineEvidence(
  repoRoot,
  processes,
  sampleCount,
) {
  if (process.platform !== "win32") {
    throw new Error("Windows GPU Engine evidence requires Windows");
  }
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 5 || sampleCount > 300) {
    throw new Error("GPU sample count must be an integer from 5 through 300");
  }
  const uniqueProcesses = [...new Map(
    processes
      .filter((process) => Number.isSafeInteger(process.pid) && process.pid > 0)
      .map((process) => [process.pid, process]),
  ).values()];
  if (uniqueProcesses.length === 0) {
    throw new Error("At least one Electron process is required for GPU attribution");
  }

  const script = NodePath.join(repoRoot, "scripts", "perf", "collect-windows-gpu-engine.ps1");
  const { stdout } = await execFileAsync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      script,
      "-ProcessIds",
      uniqueProcesses.map((process) => process.pid).join(","),
      "-SampleCount",
      String(sampleCount),
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: (sampleCount + 15) * 1_000,
      windowsHide: true,
    },
  );
  const raw = JSON.parse(stdout);
  const samples = Array.isArray(raw.samples) ? raw.samples : [];
  const summary = raw.available
    ? summarizeWindowsGpuEngineSamples(samples, uniqueProcesses)
    : {
        status: "inconclusive",
        reason: `GPU Engine counter unavailable: ${String(raw.error ?? "unknown error").slice(0, 512)}`,
        processes: [],
      };
  return {
    counterAvailable: raw.available === true,
    devices: Array.isArray(raw.devices) ? raw.devices : [],
    rawSamples: samples,
    summary,
  };
}
