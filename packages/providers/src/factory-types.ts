import type { Provider } from "@mcode/agent-model";
import type { ProviderHostPorts } from "./host-ports.js";

/** Configuration validated by every inert Provider factory. */
export interface ProviderFactoryConfiguration {
  cliPath: string;
  idleSessionTtlMs: number;
}

/** Input accepted by each public Provider factory. */
export interface ProviderFactoryInput {
  configuration: ProviderFactoryConfiguration;
  host: ProviderHostPorts;
}

/** Prepared Provider boundary returned without CLI inspection or process startup. */
export interface ProviderBoundary {
  readonly id: "claude" | "codex" | "copilot" | "cursor";
  readonly descriptor: Provider;
}
