import { useSettingsStore } from "@/stores/settingsStore";
import type { ReasoningLevel } from "@mcode/contracts";

export interface ModelProvider {
  id: string;
  name: string;
  comingSoon: boolean;
  models: ModelDefinition[];
}

/** Metadata for a selectable model in the provider registry. */
export interface ModelDefinition {
  id: string;
  label: string;
  providerId: string;
  /** Maximum context window size in tokens, if known. */
  contextWindow?: number;
}

/** Fallback context window size used when a model's limit is not yet registered. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

export const MODEL_PROVIDERS: readonly ModelProvider[] = [
  {
    id: "claude",
    name: "Claude",
    comingSoon: false,
    models: [
      { id: "claude-opus-4-6", label: "Claude Opus 4.6", providerId: "claude", contextWindow: DEFAULT_CONTEXT_WINDOW },
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", providerId: "claude", contextWindow: DEFAULT_CONTEXT_WINDOW },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", providerId: "claude", contextWindow: DEFAULT_CONTEXT_WINDOW },
    ],
  },
  {
    id: "codex",
    name: "Codex",
    comingSoon: true,
    models: [],
  },
  {
    id: "cursor",
    name: "Cursor",
    comingSoon: true,
    models: [],
  },
  {
    id: "opencode",
    name: "OpenCode",
    comingSoon: true,
    models: [],
  },
  {
    id: "gemini",
    name: "Gemini",
    comingSoon: true,
    models: [],
  },
];

/**
 * Finds a model definition by ID, with fallback prefix matching for dated variants
 * returned by the Anthropic SDK (e.g. `claude-haiku-4-5-20251001` → `claude-haiku-4-5`).
 */
export function findModelById(id: string): ModelDefinition | undefined {
  for (const p of MODEL_PROVIDERS) {
    const m = p.models.find((model) => model.id === id);
    if (m) return m;
  }
  // Dated variants use a hyphen separator, so `claude-haiku-4-5-20251001` starts with
  // `claude-haiku-4-5-` and should resolve to the base model entry.
  for (const p of MODEL_PROVIDERS) {
    const m = p.models.find((model) => id.startsWith(`${model.id}-`));
    if (m) return m;
  }
  return undefined;
}

/** Finds the provider that owns the given model ID, including dated SDK variants. */
export function findProviderForModel(modelId: string): ModelProvider | undefined {
  return MODEL_PROVIDERS.find((p) =>
    p.models.some((m) => m.id === modelId || modelId.startsWith(`${m.id}-`)),
  );
}

/** @deprecated Use `getDefaultModelId()` for settings-aware defaults. */
export function getDefaultModel(): ModelDefinition {
  return MODEL_PROVIDERS[0].models[1]; // Claude Sonnet 4.6
}

/**
 * Return the default model ID from user settings, falling back to
 * Claude Sonnet 4.6 when settings have not loaded yet.
 */
export function getDefaultModelId(): string {
  const id = useSettingsStore.getState().settings.model.defaults.id;
  return findModelById(id) ? id : "claude-sonnet-4-6";
}

/** Valid reasoning levels for fallback validation. */
const VALID_REASONING_LEVELS: readonly string[] = ["low", "medium", "high", "max"];

/**
 * Return the default reasoning level from user settings, falling back
 * to "high" when settings have not loaded or the stored value is invalid.
 */
export function getDefaultReasoningLevel(): ReasoningLevel {
  const level = useSettingsStore.getState().settings.model.defaults.reasoning;
  return VALID_REASONING_LEVELS.includes(level) ? level : "high";
}

/** Opus model IDs that support the "max" effort level. */
const MAX_EFFORT_MODEL_IDS: readonly string[] = ["claude-opus-4-6"];

/**
 * Returns true when the given model supports "max" reasoning effort.
 * Only Opus 4.6 exposes the max effort tier.
 */
export function isMaxEffortModel(modelId: string): boolean {
  return MAX_EFFORT_MODEL_IDS.includes(modelId);
}

/**
 * Normalizes a reasoning level for the given model.
 * Clamps "max" to "high" when the model does not support the max effort tier.
 */
export function normalizeReasoningLevelForModel(
  modelId: string,
  level: ReasoningLevel,
): ReasoningLevel {
  if (level === "max" && !isMaxEffortModel(modelId)) {
    return "high";
  }
  return level;
}

/** Returns the context window size for a model, falling back to DEFAULT_CONTEXT_WINDOW. */
export function getContextWindow(modelId: string): number {
  return findModelById(modelId)?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
}
