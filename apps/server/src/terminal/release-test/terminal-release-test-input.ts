import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const MAX_RELEASE_TEST_INPUT_BYTES = 128;
const MAX_FAULT_VALUE_BYTES = 64;

/** Faults supported by the protected packaged Terminal release lane. */
export const TERMINAL_RELEASE_TEST_FAULTS = [
  "startup-health-failure",
  "post-start-host-exit",
  "containment-failure",
  "missing-native-artifact",
] as const;

/** A bounded, allowlisted protected release-test fault. */
export type TerminalReleaseTestFault =
  (typeof TERMINAL_RELEASE_TEST_FAULTS)[number];

/** Validated release-test launch input passed only to the private PTY host. */
export interface TerminalReleaseTestInput {
  readonly enabled: true;
  readonly backend: "modern";
  readonly fault?: TerminalReleaseTestFault;
}

const RELEASE_TEST_KEYS = new Set([
  "MCODE_TERMINAL_RELEASE_TEST",
  "MCODE_TERMINAL_RELEASE_FAULT",
  "MCODE_TERMINAL_RELEASE_FAULTS",
]);
const RELEASE_TEST_PREFIX = "MCODE_TERMINAL_RELEASE_";

/** Optional process facts used to enforce the packaged-only release gate. */
export interface TerminalReleaseTestInputOptions {
  readonly resourcesPresent?: boolean;
}

function packagedResourcesPresent(env: Readonly<Record<string, string | undefined>>): boolean {
  const configuredResourcesPath = env.MCODE_PACKAGED_RESOURCES_ROOT;
  const electronResourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  const resourcesPath = configuredResourcesPath ?? electronResourcesPath;
  if (!resourcesPath) return false;
  try {
    if (configuredResourcesPath) {
      if (!isAbsolute(configuredResourcesPath)) return false;
      if (realpathSync(configuredResourcesPath) !== configuredResourcesPath) return false;
    }
    return (
      existsSync(resolve(resourcesPath, "app.asar")) ||
      existsSync(resolve(resourcesPath, "app.asar.unpacked"))
    );
  } catch {
    return false;
  }
}

/**
 * Parses protected release-test environment input and rejects malformed or
 * repeated fault values before they can cross into a shell environment.
 */
export function parseTerminalReleaseTestInput(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: TerminalReleaseTestInputOptions = {},
): TerminalReleaseTestInput | null {
  const releaseKeys = Object.keys(env).filter(
    (key) => key.startsWith(RELEASE_TEST_PREFIX),
  );
  if (releaseKeys.length === 0) return null;
  if (!(options.resourcesPresent ?? packagedResourcesPresent(env))) {
    throw new Error("Protected Terminal release testing requires packaged resources");
  }
  for (const key of releaseKeys) {
    if (!RELEASE_TEST_KEYS.has(key)) {
      throw new Error(`Unknown protected Terminal release-test input: ${key}`);
    }
  }
  const releaseTest = env.MCODE_TERMINAL_RELEASE_TEST;
  const backend = env.MCODE_TERMINAL_BACKEND;
  if (releaseTest !== "1" || backend !== "modern") {
    throw new Error("Protected Terminal release testing requires exact release gates");
  }
  const fault = env.MCODE_TERMINAL_RELEASE_FAULT;
  const repeatedFault = env.MCODE_TERMINAL_RELEASE_FAULTS;
  const inputBytes = Buffer.byteLength(
    JSON.stringify({ releaseTest, backend, fault, repeatedFault }),
    "utf8",
  );
  if (inputBytes > MAX_RELEASE_TEST_INPUT_BYTES) {
    throw new Error("Protected Terminal release-test input is oversized");
  }
  if (repeatedFault !== undefined) {
    throw new Error("Protected Terminal release-test fault input is repeated");
  }
  if (fault === undefined) return { enabled: true, backend: "modern" };
  if (
    Buffer.byteLength(fault, "utf8") > MAX_FAULT_VALUE_BYTES ||
    !TERMINAL_RELEASE_TEST_FAULTS.includes(fault as TerminalReleaseTestFault)
  ) {
    throw new Error("Protected Terminal release-test fault is not allowlisted");
  }
  return { enabled: true, backend: "modern", fault: fault as TerminalReleaseTestFault };
}

/** Returns whether a variable must be withheld from a spawned shell. */
export function isTerminalReleaseTestEnvironmentName(name: string): boolean {
  return name.startsWith(RELEASE_TEST_PREFIX);
}
