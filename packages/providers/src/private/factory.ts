import type { ProviderCapabilityName } from "@mcode/agent-model";
import type {
  ProviderBoundary,
  ProviderFactoryInput,
} from "../factory-types.js";

const MAX_CLI_PATH_LENGTH = 32_768;
const MAX_IDLE_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;

type ProviderBoundaryId = ProviderBoundary["id"];

/** Private protocol behavior retained with a prepared Provider boundary. */
export interface ProviderProtocolBinding {
  readonly kind: "acp";
  encodeRequest(method: string, params?: unknown): string;
}

const protocolBindings = new WeakMap<ProviderBoundary, ProviderProtocolBinding>();

/** Returns the private protocol binding for package-local Provider machinery. */
export function providerProtocolBinding(
  boundary: ProviderBoundary,
): ProviderProtocolBinding | undefined {
  return protocolBindings.get(boundary);
}

/** Associates package-private protocol machinery with a usable Provider boundary. */
export function bindProviderProtocol(
  boundary: ProviderBoundary,
  protocol: ProviderProtocolBinding,
): void {
  protocolBindings.set(boundary, protocol);
}

const requiredHostMethods = [
  ["environment", "snapshot"],
  ["processes", "attach"],
  ["processes", "terminateTree"],
  ["browser", "stage"],
  ["browser", "releaseSession"],
  ["threadControl", "bootstrap"],
  ["threadControl", "close"],
  ["grants", "consume"],
  ["events", "submit"],
] as const;

/** Creates one validated Provider boundary without causing Provider I/O. */
export function createProviderBoundary(
  id: ProviderBoundaryId,
  capabilities: readonly ProviderCapabilityName[],
  input: ProviderFactoryInput,
  protocol?: ProviderProtocolBinding,
): ProviderBoundary {
  validateConfiguration(input.configuration);
  validateHostPorts(input.host);
  const boundary = Object.freeze({
    id,
    descriptor: Object.freeze({
      id,
      capabilities: capabilities.map((name) => ({ name, support: "supported" as const })),
    }),
  });
  if (protocol) protocolBindings.set(boundary, protocol);
  return boundary;
}

function validateConfiguration(configuration: ProviderFactoryInput["configuration"]): void {
  if (!configuration || typeof configuration !== "object") {
    throw new TypeError("Provider configuration is required");
  }
  if (
    typeof configuration.cliPath !== "string"
    || configuration.cliPath.trim().length === 0
    || configuration.cliPath.length > MAX_CLI_PATH_LENGTH
    || configuration.cliPath.includes("\0")
  ) {
    throw new TypeError("Provider configuration cliPath is invalid");
  }
  if (
    !Number.isSafeInteger(configuration.idleSessionTtlMs)
    || configuration.idleSessionTtlMs < 1
    || configuration.idleSessionTtlMs > MAX_IDLE_SESSION_TTL_MS
  ) {
    throw new TypeError("Provider configuration idleSessionTtlMs is invalid");
  }
}

function validateHostPorts(host: ProviderFactoryInput["host"]): void {
  for (const [portName, methodName] of requiredHostMethods) {
    const port = host?.[portName];
    if (!port || typeof (port as unknown as Record<string, unknown>)[methodName] !== "function") {
      throw new TypeError(`Provider host port ${portName}.${methodName} is required`);
    }
  }
}
