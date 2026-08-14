import type { Provider } from "@mcode/agent-model";
import type { IAgentProvider, SkillInfo, StoredAttachment } from "@mcode/contracts";
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
  codex?: CodexProviderPorts;
}

/** Server-owned authorities required by the Codex Provider. */
export interface CodexProviderPorts {
  settings: {
    get(): { cliPath: string; fastMode: boolean } | Promise<{ cliPath: string; fastMode: boolean }>;
  };
  attachments: {
    persistGeneratedImageFromPath(threadId: string, sourcePath: string): StoredAttachment;
  };
  catalog: {
    currentSkills(cwd?: string): SkillInfo[];
    currentPrompts(): SkillInfo[];
    refreshCustomPrompts(): Promise<{ prompts: SkillInfo[] }>;
    shutdown(): Promise<void>;
  };
}

/** Prepared Provider boundary returned without CLI inspection or process startup. */
export interface ProviderBoundary {
  readonly id: "claude" | "codex" | "copilot" | "cursor";
  readonly descriptor: Provider;
}

/** Usable Codex Provider returned by its public factory. */
export type CodexProviderBoundary = IAgentProvider & ProviderBoundary;
