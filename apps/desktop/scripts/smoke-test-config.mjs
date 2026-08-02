const DEFAULT_SMOKE_TIMEOUT_MS = 30_000;
const ROSETTA_SMOKE_TIMEOUT_MS = 60_000;

/**
 * Select the packaged-server startup budget for the current host and target.
 *
 * @param {{hostPlatform: string, hostArch: string, targetPlatform: string, targetArch: string}} input
 * @returns {number}
 */
export function getSmokeTimeoutMs({ hostPlatform, hostArch, targetPlatform, targetArch }) {
  const isRosettaTarget = hostPlatform === "darwin"
    && hostArch === "arm64"
    && targetPlatform === "darwin"
    && targetArch === "x64";
  return isRosettaTarget ? ROSETTA_SMOKE_TIMEOUT_MS : DEFAULT_SMOKE_TIMEOUT_MS;
}

/**
 * Classify the readiness result captured when polling reaches its deadline.
 *
 * @param {{healthy: boolean, exitedAtDeadline: boolean}} input
 * @returns {"healthy" | "crashed" | "timed-out"}
 */
export function classifySmokeOutcome({ healthy, exitedAtDeadline }) {
  if (healthy) {
    return "healthy";
  }
  return exitedAtDeadline ? "crashed" : "timed-out";
}
