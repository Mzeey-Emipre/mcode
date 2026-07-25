import type { ProviderModelInfo } from "./models.js";

/** Complete Claude fallback catalog shared by server discovery and web pickers. */
export const CLAUDE_STATIC_MODELS: readonly ProviderModelInfo[] = [
  {
    id: "claude-opus-5",
    name: "Claude Opus 5",
    contextWindow: 1_000_000,
    supportsReasoning: true,
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "high",
  },
  ...[
    ["claude-fable-5", "Claude Fable 5"],
    ["claude-sonnet-5", "Claude Sonnet 5"],
  ].map(([id, name]) => ({
    id,
    name,
    contextWindow: 1_000_000,
    supportsReasoning: true,
    supportedReasoningEfforts: ["low", "medium", "high", "max"] as const,
    defaultReasoningEffort: "high" as const,
  })),
  ...[
    ["claude-opus-4-8", "Claude Opus 4.8"],
    ["claude-opus-4-7", "Claude Opus 4.7"],
  ].map(([id, name]) => ({
    id,
    name,
    contextWindow: 1_000_000,
    supportsReasoning: true,
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"] as const,
    defaultReasoningEffort: "high" as const,
  })),
  ...[
    ["claude-opus-4-6", "Claude Opus 4.6"],
    ["claude-sonnet-4-6", "Claude Sonnet 4.6"],
  ].map(([id, name]) => ({
    id,
    name,
    contextWindow: 1_000_000,
    supportsReasoning: true,
    supportedReasoningEfforts: ["low", "medium", "high", "max"] as const,
    defaultReasoningEffort: "high" as const,
  })),
  {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    contextWindow: 200_000,
    supportsReasoning: false,
  },
];
