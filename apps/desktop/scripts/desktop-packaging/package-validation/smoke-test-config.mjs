const DEFAULT_PACKAGED_RUNTIME_STARTUP_TIMEOUT_MS = 30_000;
const ROSETTA_PACKAGED_RUNTIME_STARTUP_TIMEOUT_MS = 60_000;

/**
 * Choose the Electron executable used only by the unsigned package smoke test.
 *
 * @param {{renamedBinary: string, electron: string, allowsUnsignedMacFallback?: boolean, hasRenamedBinary: boolean, hasElectron: boolean}} input
 * @returns {string | null}
 */
export function selectPackagedPtyHost({
  renamedBinary,
  electron,
  allowsUnsignedMacFallback,
  hasRenamedBinary,
  hasElectron,
}) {
  if (allowsUnsignedMacFallback) return hasElectron ? electron : null;
  return hasRenamedBinary ? renamedBinary : null;
}

/**
 * Select the packaged-runtime startup budget for the current host and target.
 *
 * @param {{hostPlatform: string, hostArch: string, targetPlatform: string, targetArch: string}} input
 * @returns {number}
 */
export function getPackagedRuntimeStartupTimeoutMs({ hostPlatform, hostArch, targetPlatform, targetArch }) {
  const isRosettaTarget = hostPlatform === "darwin"
    && hostArch === "arm64"
    && targetPlatform === "darwin"
    && targetArch === "x64";
  return isRosettaTarget
    ? ROSETTA_PACKAGED_RUNTIME_STARTUP_TIMEOUT_MS
    : DEFAULT_PACKAGED_RUNTIME_STARTUP_TIMEOUT_MS;
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
