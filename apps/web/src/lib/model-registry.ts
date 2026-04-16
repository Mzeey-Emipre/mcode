import { useSettingsStore } from "@/stores/settingsStore";
import type { ReasoningLevel } from "@mcode/contracts";

/** A provider entry in the model registry. */
export interface ModelProvider {
  id: string;
  name: string;
  comingSoon: boolean;
  /** Whether this provider supports one-shot structured completion (e.g. PR draft generation). */
  supportsCompletion?: boolean;
  models: ModelDefinition[];
  /** Whether this provider supports live model listing via listProviderModels(). */
  supportsModelListing?: boolean;
}

/**
 * Reasoning effort level values accepted by the Codex SDK.
 * Distinct from mcode's internal ReasoningLevel which uses "max" for Claude.
 */
export type CodexReasoningLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

/** Metadata for a selectable model in the provider registry. */
export interface ModelDefinition {
  id: string;
  label: string;
  providerId: string;
  /** Optional display group for organizing models in selectors (e.g. "OpenAI", "Anthropic"). */
  group?: string;
  /** Maximum context window size in tokens, if known. */
  contextWindow?: number;
  /**
   * Reasoning effort levels this model supports, ordered low→high.
   * Omit for models that use the standard mcode reasoning levels.
   */
  supportedReasoningLevels?: readonly CodexReasoningLevel[];
  /** Default reasoning effort level for this model. */
  defaultReasoningLevel?: CodexReasoningLevel;
  /** Billing rate multiplier relative to the base rate (e.g. 1, 0.33, 3). */
  multiplier?: number;
}

export const MODEL_PROVIDERS: readonly ModelProvider[] = [
  {
    id: "claude",
    name: "Claude",
    comingSoon: false,
    supportsCompletion: true,
    models: [
      { id: "claude-opus-4-7", label: "Claude Opus 4.7", providerId: "claude" },
      { id: "claude-opus-4-6", label: "Claude Opus 4.6", providerId: "claude" },
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", providerId: "claude" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", providerId: "claude" },
    ],
  },
  {
    id: "codex",
    name: "Codex",
    comingSoon: false,
    models: [
      {
        id: "gpt-5.4",
        label: "GPT-5.4",
        providerId: "codex",
        supportedReasoningLevels: ["low", "medium", "high", "xhigh"],
        defaultReasoningLevel: "medium",
      },
      {
        id: "gpt-5.4-mini",
        label: "GPT-5.4 Mini",
        providerId: "codex",
        // Not yet in models.json catalog; assume same range as gpt-5.4
        supportedReasoningLevels: ["low", "medium", "high", "xhigh"],
        defaultReasoningLevel: "medium",
      },
      {
        id: "gpt-5.3-codex",
        label: "GPT-5.3 Codex",
        providerId: "codex",
        supportedReasoningLevels: ["low", "medium", "high", "xhigh"],
        defaultReasoningLevel: "medium",
      },
      {
        id: "gpt-5.2-codex",
        label: "GPT-5.2 Codex",
        providerId: "codex",
        supportedReasoningLevels: ["low", "medium", "high", "xhigh"],
        defaultReasoningLevel: "medium",
      },
      {
        id: "gpt-5.1-codex-mini",
        label: "GPT-5.1 Codex Mini",
        providerId: "codex",
        // gpt-5.1-codex-mini treated same as gpt-5.1-codex: up to high, no xhigh
        supportedReasoningLevels: ["low", "medium", "high"],
        defaultReasoningLevel: "medium",
      },
    ],
  },
  {
    id: "copilot",
    name: "GitHub Copilot",
    comingSoon: false,
    supportsModelListing: true,
    // Minimal static fallback — the live list from listProviderModels() is the
    // source of truth. These are shown only while the spinner is loading or if
    // the fetch fails (e.g. Copilot client not connected).
    models: [
      { id: "gpt-4.1", label: "GPT-4.1", providerId: "copilot", group: "OpenAI" },
      { id: "claude-sonnet-4.6", label: "Claude Sonnet 4.6", providerId: "copilot", group: "Anthropic" },
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", providerId: "copilot", group: "Google" },
    ],
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
 * Flat model list sorted longest-ID-first, precomputed once at module load.
 * Used by `matchDatedVariant` to avoid reallocating and sorting on every call.
 */
const SORTED_ALL_MODELS: readonly ModelDefinition[] = MODEL_PROVIDERS
  .flatMap((p) => p.models)
  .sort((a, b) => b.id.length - a.id.length);

/**
 * Matches a dated SDK variant ID (e.g. `claude-haiku-4-5-20251001`) to its base
 * model definition by prefix. Longest-first order ensures a more specific ID is
 * never shadowed by a shorter prefix.
 */
function matchDatedVariant(id: string): ModelDefinition | undefined {
  return SORTED_ALL_MODELS.find((m) => id.startsWith(`${m.id}-`));
}

/**
 * Finds a model definition by ID, with fallback prefix matching for dated variants
 * returned by the Anthropic SDK (e.g. `claude-haiku-4-5-20251001` -> `claude-haiku-4-5`).
 */
export function findModelById(id: string): ModelDefinition | undefined {
  for (const p of MODEL_PROVIDERS) {
    const m = p.models.find((model) => model.id === id);
    if (m) return m;
  }
  return matchDatedVariant(id);
}

/**
 * Resolves the model ID to display when switching to a thread with no draft.
 * Returns the thread's locked model normalized to its base ID if recognized,
 * otherwise falls back to the supplied default.
 *
 * @param lockedModel - The thread's stored model ID (may be a dated SDK variant, null, or undefined).
 * @param defaultModelId - Fallback model ID when the locked model is absent or unrecognized.
 */
export function resolveThreadModelId(
  lockedModel: string | null | undefined,
  defaultModelId: string,
): string {
  if (lockedModel) {
    const def = findModelById(lockedModel);
    if (def) return def.id;
  }
  return defaultModelId;
}

/** Finds the provider that owns the given model ID, including dated SDK variants. */
export function findProviderForModel(modelId: string): ModelProvider | undefined {
  const def = findModelById(modelId);
  if (!def) return undefined;
  return MODEL_PROVIDERS.find((p) => p.models.some((m) => m.id === def.id));
}

/** @deprecated Use `getDefaultModelId()` for settings-aware defaults. */
export function getDefaultModel(): ModelDefinition {
  return MODEL_PROVIDERS[0].models[2]; // Claude Sonnet 4.6
}

/**
 * Return the default model ID from user settings, falling back to
 * Claude Sonnet 4.6 when settings have not loaded yet.
 */
export function getDefaultModelId(): string {
  const id = useSettingsStore.getState().settings.model.defaults.id;
  return findModelById(id) ? id : "claude-sonnet-4-6";
}

/**
 * Return the default provider ID from user settings, falling back to "claude".
 * Needed because multiple providers share the same model IDs (e.g. Codex and
 * Copilot both expose "gpt-5.3-codex"), so the provider cannot be inferred
 * from the model ID alone.
 */
export function getDefaultProviderId(): string {
  return useSettingsStore.getState().settings.model.defaults.provider ?? "claude";
}

/** Valid reasoning levels for fallback validation. */
const VALID_REASONING_LEVELS: readonly string[] = ["low", "medium", "high", "max", "xhigh"];

/**
 * Return the default reasoning level from user settings, falling back
 * to "high" when settings have not loaded or the stored value is invalid.
 */
export function getDefaultReasoningLevel(): ReasoningLevel {
  const level = useSettingsStore.getState().settings.model.defaults.reasoning;
  return VALID_REASONING_LEVELS.includes(level) ? level : "high";
}

/** Opus model IDs that support the "max" effort level. */
const MAX_EFFORT_MODEL_IDS: readonly string[] = ["claude-opus-4-7", "claude-opus-4-6"];

/** Claude model IDs that support the "xhigh" effort level. */
const XHIGH_EFFORT_MODEL_IDS: readonly string[] = ["claude-opus-4-7"];

/**
 * Returns true when the given model supports "max" reasoning effort.
 * Opus 4.6 and 4.7 expose the max effort tier. Accepts dated SDK variants
 * (e.g. `claude-opus-4-6-20251001`) by normalizing through `findModelById`.
 */
export function isMaxEffortModel(modelId: string): boolean {
  const baseId = findModelById(modelId)?.id ?? modelId;
  return MAX_EFFORT_MODEL_IDS.includes(baseId);
}

/**
 * Returns true when the given Claude model supports "xhigh" reasoning effort.
 * Only Opus 4.7+ exposes the xhigh effort tier. Accepts dated SDK variants
 * by normalizing through `findModelById`.
 */
export function isXhighEffortModel(modelId: string): boolean {
  const baseId = findModelById(modelId)?.id ?? modelId;
  return XHIGH_EFFORT_MODEL_IDS.includes(baseId);
}

/**
 * Normalizes a reasoning level for the given model.
 * - Clamps "max" to "high" for non-Opus Claude models.
 * - Clamps "xhigh" to "high" for Claude models below Opus 4.7.
 */
export function normalizeReasoningLevelForModel(
  modelId: string,
  level: ReasoningLevel,
): ReasoningLevel {
  const codexLevels = getCodexReasoningLevels(modelId);
  if (codexLevels) {
    // For Codex models: xhigh is valid only if supported, otherwise clamp to high
    if (level === "xhigh" && !codexLevels.includes("xhigh")) return "high";
    // max is not a Codex level — treat as xhigh if supported, else high
    if (level === "max") return codexLevels.includes("xhigh") ? "xhigh" : "high";
    return level;
  }
  // Claude: xhigh requires Opus 4.7+
  if (level === "xhigh" && !isXhighEffortModel(modelId)) return "high";
  if (level === "max" && !isMaxEffortModel(modelId)) return "high";
  return level;
}

/** Returns the context window size for a model, if statically known. */
export function getContextWindow(modelId: string): number | undefined {
  return findModelById(modelId)?.contextWindow;
}

/**
 * Returns the Codex-specific reasoning levels for a model, or null if the model
 * uses mcode's standard reasoning levels (i.e. is not a Codex model).
 */
export function getCodexReasoningLevels(modelId: string): readonly CodexReasoningLevel[] | null {
  return findModelById(modelId)?.supportedReasoningLevels ?? null;
}

/**
 * Returns true when the given Codex model supports the "xhigh" reasoning effort tier.
 */
export function isXhighModel(modelId: string): boolean {
  const levels = getCodexReasoningLevels(modelId);
  return levels?.includes("xhigh") ?? false;
}
