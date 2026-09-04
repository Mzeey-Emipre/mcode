import type { ProviderModelInfo } from "./models.js";

/**
 * Static Codex model rows. Codex does not support dynamic model discovery,
 * so these are returned directly from `CodexProvider.listModels()`.
 * Single source for both server and web model-registry fallback.
 */
export const CODEX_STATIC_MODELS: readonly ProviderModelInfo[] = [
  {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    group: "OpenAI",
    contextWindow: 372_000,
    supportsVision: true,
    supportsReasoning: true,
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "low",
    supportsUltraOrchestration: true,
  },
  {
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    group: "OpenAI",
    supportsReasoning: true,
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    supportsUltraOrchestration: true,
  },
  {
    id: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    group: "OpenAI",
    contextWindow: 372_000,
    supportsVision: true,
    supportsReasoning: true,
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "medium",
    supportsUltraOrchestration: true,
  },
  {
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    group: "OpenAI",
    contextWindow: 372_000,
    supportsVision: true,
    supportsReasoning: true,
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.5",
    name: "GPT-5.5",
    group: "OpenAI",
    supportsReasoning: true,
    supportedReasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    group: "OpenAI",
    supportsReasoning: true,
    supportedReasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    group: "OpenAI",
    supportsReasoning: true,
    supportedReasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.3-codex",
    name: "GPT-5.3 Codex",
    group: "OpenAI",
    supportsReasoning: true,
    supportedReasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "medium",
  },
];

/** Returns whether a Codex model advertises the provider-native Ultra delegation tier. */
export function supportsCodexUltraOrchestration(modelId: string): boolean {
  const model = CODEX_STATIC_MODELS.find(
    (candidate) => modelId === candidate.id || modelId.startsWith(`${candidate.id}-`),
  );
  return model?.supportsUltraOrchestration === true;
}
