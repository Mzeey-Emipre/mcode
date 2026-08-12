import type { ProviderBoundary, ProviderFactoryInput } from "./factory-types.js";
import { createProviderBoundary } from "./private/factory.js";
import { createCursorAcpProvider } from "./private/protocols/acp.js";

/** Prepares the Claude Provider boundary without inspecting or spawning its CLI. */
export function createClaudeProvider(input: ProviderFactoryInput): ProviderBoundary {
  return createProviderBoundary("claude", [], input);
}

/** Prepares the Codex Provider boundary without inspecting or spawning its CLI. */
export function createCodexProvider(input: ProviderFactoryInput): ProviderBoundary {
  return createProviderBoundary("codex", [], input);
}

/** Prepares the Copilot Provider boundary without inspecting or spawning its CLI. */
export function createCopilotProvider(input: ProviderFactoryInput): ProviderBoundary {
  return createProviderBoundary("copilot", [], input);
}

/** Prepares the Cursor Provider boundary with private generic ACP machinery. */
export function createCursorProvider(input: ProviderFactoryInput): ProviderBoundary {
  return createCursorAcpProvider(input);
}
