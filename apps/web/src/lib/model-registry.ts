import { useSettingsStore } from "@/stores/settingsStore";
import { CLAUDE_STATIC_MODELS, CODEX_STATIC_MODELS, CURSOR_STATIC_MODEL_FALLBACK } from "@mcode/contracts";
import type { ContextWindowMode, ProviderId, ReasoningLevel } from "@mcode/contracts";
import {
  MODEL_CONTEXT_WINDOWS_DEFAULT,
  getModelContextWindow as sharedGetModelContextWindow,
} from "@mcode/shared/model-context";

// Import from the subpath, NOT the barrel. The barrel re-exports
// winston-bound logging at the top of index.ts, which throws
// "process is not defined" the moment it loads in a browser and
// prevents React from mounting (blank screen).
export {
  isXhighEffortModel,
  isMaxEffortModel,
  supportsEffortParameter,
  supports1MContextWindow,
  supportsThinkingToggle,
  normalizeReasoningLevelForModel,
} from "@mcode/shared/model-effort";

/** A provider entry in the model registry. */
export interface ModelProvider {
  id: string;
  name: string;
  comingSoon: boolean;
  /** Whether this provider supports one-shot structured completion (e.g. PR draft generation). */
  supportsCompletion?: boolean;
  models: ModelDefinition[];
}

/**
 * Reasoning effort level values accepted by the Codex app-server.
 */
export type CodexReasoningLevel = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

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
  /**
   * ISO date (YYYY-MM-DD) after which the model can no longer be selected.
   * Mcode authenticates via subscription credentials (never API keys), so a
   * model whose subscription access window the vendor has end-dated stays
   * selectable through this day, then renders greyed-out in pickers.
   */
  availableUntil?: string;
}

/**
 * Returns true when the model is selectable today. Models whose
 * `availableUntil` date has passed render greyed-out in pickers.
 */
export function isModelAvailable(m: ModelDefinition, now: Date = new Date()): boolean {
  if (!m.availableUntil) return true;
  // Compare against the local calendar date, not UTC: `availableUntil` is a
  // zoneless wall date and the picker renders its "Until <date>" badge with
  // local formatting, so a UTC basis would grey the model out a day early or
  // late for users far from UTC.
  const localYmd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return localYmd <= m.availableUntil;
}

export const MODEL_PROVIDERS: readonly ModelProvider[] = [
  {
    id: "claude",
    name: "Claude",
    comingSoon: false,
    supportsCompletion: true,
    models: CLAUDE_STATIC_MODELS.map((model) => ({
      id: model.id,
      label: model.name,
      providerId: "claude",
      contextWindow: MODEL_CONTEXT_WINDOWS_DEFAULT[model.id],
    })),
  },
  {
    id: "codex",
    name: "Codex",
    comingSoon: false,
    models: CODEX_STATIC_MODELS.map((model) => ({
      id: model.id,
      label: model.name,
      providerId: "codex",
      group: model.group,
      contextWindow: model.contextWindow,
      supportedReasoningLevels: model.supportedReasoningEfforts,
      defaultReasoningLevel: model.defaultReasoningEffort,
    })),
  },
  {
    id: "copilot",
    name: "GitHub Copilot",
    comingSoon: false,
    supportsCompletion: true,
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
    comingSoon: false,
    // Minimal static fallback — live list comes from listProviderModels (`cursor-agent models`).
    models: CURSOR_STATIC_MODEL_FALLBACK.map((m) => ({
      id: m.id,
      label: m.name,
      providerId: "cursor",
      group: m.group,
    })),
  },
  {
    id: "opencode",
    name: "OpenCode",
    comingSoon: false,
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
 * Merges live model definitions into the static Settings catalog by model ID.
 */
export function pickProviderModelsForSettings(
  staticModels: readonly ModelDefinition[],
  dynamicModels: readonly ModelDefinition[] | undefined,
): ModelDefinition[] {
  if (dynamicModels != null && dynamicModels.length > 0) {
    const dynamicById = new Map(dynamicModels.map((model) => [model.id, model]));
    const merged = staticModels.map((model) => {
      const dynamicModel = dynamicById.get(model.id);
      return {
        ...model,
        ...dynamicModel,
        contextWindow: model.providerId === "claude"
          ? model.contextWindow ?? dynamicModel?.contextWindow
          : dynamicModel?.contextWindow ?? model.contextWindow,
      };
    });
    const staticIds = new Set(staticModels.map((model) => model.id));
    return [...merged, ...dynamicModels.filter((model) => !staticIds.has(model.id))];
  }
  return [...staticModels];
}

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
 * Normalizes dated SDK variants and known static IDs; passes through any other
 * non-empty string so dynamic provider models stay intact.
 *
 * @param lockedModel - The thread's stored model ID (may be a dated SDK variant, null, or undefined).
 * @param defaultModelId - Fallback model ID when the locked model is absent.
 */
export function resolveThreadModelId(
  lockedModel: string | null | undefined,
  defaultModelId: string,
): string {
  if (!lockedModel) return defaultModelId;
  const def = findModelById(lockedModel);
  if (def) return def.id;
  // Dynamic provider models (Cursor, Copilot, future Claude SKUs) are not in
  // the static registry but are valid persisted IDs.
  return lockedModel;
}

/** Finds the provider that owns the given model ID, including dated SDK variants. */
export function findProviderForModel(modelId: string): ModelProvider | undefined {
  const def = findModelById(modelId);
  if (!def) return undefined;
  return MODEL_PROVIDERS.find((p) => p.models.some((m) => m.id === def.id));
}

/** @deprecated Use `getDefaultModelId()` for settings-aware defaults. */
export function getDefaultModel(): ModelDefinition {
  const claude = MODEL_PROVIDERS[0];
  // Skip date-gated entries so a not-yet-selectable model never becomes the default.
  return claude.models.find((m) => isModelAvailable(m)) ?? claude.models[0];
}

const RETIRED_CODEX_MODEL_IDS: ReadonlySet<string> = new Set([
  "gpt-5.2-codex",
  "gpt-5.1-codex-mini",
]);

function providerStaticFallback(providerId: string, catalog: ModelProvider | undefined): string {
  if (providerId === "claude") return "claude-sonnet-4-6";
  return catalog?.models[0]?.id ?? "claude-sonnet-4-6";
}

function matchesConfiguredProvider(
  modelId: string,
  providerId: string,
  catalog: ModelProvider | undefined,
): boolean {
  if (catalog?.models.some((model) => model.id === modelId)) return true;
  return findModelById(modelId)?.providerId === providerId;
}

function resolveDynamicModelId(
  modelId: string,
  providerId: string,
  fallback: string,
): string {
  const definition = findModelById(modelId);
  if (definition) return fallback;
  if (providerId === "codex" && RETIRED_CODEX_MODEL_IDS.has(modelId)) return fallback;
  return modelId;
}

/**
 * Return the default model ID from user settings. Empty or invalid values
 * resolve to a model that belongs to the configured provider (never a Claude
 * ID when the default provider is Codex or another catalog).
 */
export function getDefaultModelId(): string {
  const { settings } = useSettingsStore.getState();
  const providerId = settings.model.defaults.provider ?? "claude";
  const catalog = MODEL_PROVIDERS.find((p) => p.id === providerId);
  const fallback = providerStaticFallback(providerId, catalog);

  const rawId = settings.model.defaults.id;
  if (!rawId?.trim()) {
    return fallback;
  }

  const id = rawId.trim();
  if (matchesConfiguredProvider(id, providerId, catalog)) return id;

  // Dynamic provider models are valid persisted IDs when the static registry
  // cannot resolve them. A static match for another provider is stale.
  return resolveDynamicModelId(id, providerId, fallback);
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
const VALID_REASONING_LEVELS: readonly string[] = [
  "none", "minimal", "low", "medium", "high", "max", "xhigh",
];

/**
 * Return the default reasoning level from user settings, falling back
 * to "high" when settings have not loaded or the stored value is invalid.
 */
export function getDefaultReasoningLevel(): ReasoningLevel {
  const level = useSettingsStore.getState().settings.model.defaults.reasoning;
  return VALID_REASONING_LEVELS.includes(level) ? level : "high";
}

/** Returns the context window size for a model, if statically known. */
export function getContextWindow(modelId: string): number | undefined {
  return findModelById(modelId)?.contextWindow;
}

/**
 * Returns the active context window (tokens) for a model and the user's
 * selected mode. "1m" yields the extended window only when the model supports
 * it; otherwise falls through to the model's default 200k window.
 */
export function getModelContextWindow(
  modelId: string,
  mode: ContextWindowMode = "200k",
): number | undefined {
  return sharedGetModelContextWindow(modelId, mode);
}

/**
 * Providers whose backends do **not** accept a per-call reasoning-effort
 * parameter. The Composer hides the reasoning pill for these providers
 * regardless of the active model id (cursor models, for example, can share
 * an id with a provider that does expose effort tiers, so a model-only
 * check would surface the pill incorrectly).
 *
 * Add a provider id here when integrating a backend that picks reasoning
 * effort internally (cursor's Composer mode, hosted assistants without an
 * exposed effort knob, etc.). Entries are matched by exact `ProviderId`.
 */
export const PROVIDERS_WITHOUT_REASONING_LEVELS: ReadonlySet<ProviderId> = new Set<ProviderId>([
  "cursor",
  "copilot",
]);

/**
 * Returns true when the given provider exposes a reasoning-effort knob
 * that the Composer should surface. Falls back to `true` for unknown
 * provider strings so newly added providers default to "show the pill",
 * forcing an opt-out via {@link PROVIDERS_WITHOUT_REASONING_LEVELS}.
 */
export function providerSupportsReasoningLevels(provider: ProviderId | string | undefined): boolean {
  if (!provider) return true;
  return !PROVIDERS_WITHOUT_REASONING_LEVELS.has(provider as ProviderId);
}

/**
 * Providers that support promoting a queued message past the current turn
 * via a clean SDK interrupt + resume. Claude's Agent SDK closes its prompt
 * queue cleanly via `stopSession`, so the next message can flow immediately.
 * Other providers (Codex JSON-RPC, Copilot, Cursor, Gemini) do not yet expose
 * a deterministic mid-turn interrupt - "Send now" stays hidden for them
 * rather than risk a half-aborted turn.
 */
const PROVIDERS_WITH_SEND_NOW: ReadonlySet<ProviderId> = new Set(["claude"]);

/**
 * Returns true when the given provider supports the queue's "Send now"
 * affordance: stop the current turn, then immediately dispatch a queued
 * message instead of waiting for the running turn to finish.
 */
export function providerSupportsSendNow(provider: ProviderId | string | undefined): boolean {
  if (!provider) return false;
  return PROVIDERS_WITH_SEND_NOW.has(provider as ProviderId);
}

/**
 * Returns the Codex-specific reasoning levels for a model, or null if the model
 * uses mcode's standard reasoning levels (i.e. is not a Codex model).
 */
export function getCodexReasoningLevels(modelId: string): readonly CodexReasoningLevel[] | null {
  return findModelById(modelId)?.supportedReasoningLevels ?? null;
}

/** Returns the Codex model's default reasoning level, or null for non-Codex models. */
export function getCodexDefaultReasoningLevel(modelId: string): CodexReasoningLevel | null {
  return findModelById(modelId)?.defaultReasoningLevel ?? null;
}

/**
 * Returns true when the given Codex model supports the "xhigh" reasoning effort tier.
 */
export function isXhighModel(modelId: string): boolean {
  const levels = getCodexReasoningLevels(modelId);
  return levels?.includes("xhigh") ?? false;
}
