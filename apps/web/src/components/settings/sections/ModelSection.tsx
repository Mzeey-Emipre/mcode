import { useMemo, useEffect, useRef, type ComponentProps, type ReactNode } from "react";
import { ProviderSection } from "./ProviderSection";
import { useSettingsStore } from "@/stores/settingsStore";
import { useProviderAvailabilityStore } from "@/stores/providerAvailabilityStore";
import { useProviderModelsStore } from "@/stores/providerModelsStore";
import {
  MODEL_PROVIDERS,
  isMaxEffortModel,
  isXhighEffortModel,
  supportsEffortParameter,
  supports1MContextWindow,
  supportsThinkingToggle,
  normalizeReasoningLevelForModel,
  getCodexReasoningLevels,
  getCodexDefaultReasoningLevel,
  pickProviderModelsForSettings,
  providerSupportsReasoningLevels,
  type ModelDefinition,
} from "@/lib/model-registry";
import { SettingRow } from "../SettingRow";
import { SegControl } from "../SegControl";
import { SettingsGroup } from "../SettingsGroup";
import { SearchableGroupedPicker } from "../SearchableGroupedPicker";
import { SettingsProviderPicker } from "../SettingsProviderPicker";
import { Switch } from "@/components/ui/switch";
import type { ContextWindowMode, ProviderAvailability, SettingsProviderId, ReasoningLevel } from "@mcode/contracts";
import { Sparkles } from "lucide-react";
import {
  ClaudeIcon,
  CodexIcon,
  CursorProviderIcon,
  OpenCodeIcon,
  GeminiIcon,
  CopilotIcon,
} from "@/components/chat/ProviderIcons";
import { useToastStore } from "@/stores/toastStore";

/** Maps provider id to its brand icon component. */
const PROVIDER_ICONS: Record<string, ReactNode> = {
  claude: <ClaudeIcon size={12} />,
  codex: <CodexIcon size={12} />,
  copilot: <CopilotIcon size={12} />,
  cursor: <CursorProviderIcon size={12} />,
  opencode: <OpenCodeIcon size={12} />,
  gemini: <GeminiIcon size={12} />,
};


const REASONING_OPTIONS_BASE = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

/** Codex reasoning effort labels mapped from SDK level names. */
const CODEX_REASONING_LABELS: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
  max: "Max",
  ultra: "Ultra",
};

type ProviderOptions = ComponentProps<typeof SettingsProviderPicker>["options"];
type ModelPickerOptions = ComponentProps<typeof SearchableGroupedPicker>["options"];
type ReasoningOptions = ComponentProps<typeof SegControl>["options"];

/**
 * Builds a provider option for the Model / Utility Model pickers. A provider is
 * only rendered as disabled once its availability row has loaded and indicates it
 * is unusable (disabled by user, no adapter, or CLI missing). While availability
 * is still loading, the option stays selectable to avoid falsely blanking every
 * entry on first paint.
 */
function buildProviderOption(
  p: (typeof MODEL_PROVIDERS)[number],
  avail: ProviderAvailability | undefined,
): { value: string; label: string; disabled: boolean; icon: ReactNode; title: string | undefined } {
  const unavailable =
    avail != null &&
    (!avail.enabled || !avail.hasAdapter || avail.cli.status === "not_found");
  const title = p.comingSoon
    ? "Coming soon"
    : avail == null
      ? undefined
      : !avail.enabled
        ? "Not enabled"
        : !avail.hasAdapter
          ? "Unavailable"
          : avail.cli.status === "not_found"
            ? "CLI not found"
            : undefined;
  return {
    value: p.id,
    label: p.name,
    disabled: p.comingSoon || unavailable,
    icon: PROVIDER_ICONS[p.id],
    title,
  };
}

function getProviderCliPath(
  providerId: string,
  cliPaths: { cursor: string; copilot: string },
): string {
  const cliPathByProvider = {
    cursor: cliPaths.cursor,
    copilot: cliPaths.copilot,
  };
  return cliPathByProvider[providerId as keyof typeof cliPathByProvider] ?? "";
}

function isModelStale(
  modelId: string,
  modelsLoading: boolean,
  catalogModels: readonly ModelDefinition[],
): boolean {
  return (
    !modelsLoading &&
    Boolean(modelId.trim()) &&
    catalogModels.length > 0 &&
    !catalogModels.some((model) => model.id === modelId)
  );
}

function shouldShowReasoning(provider: string, modelId: string): boolean {
  return providerSupportsReasoningLevels(provider) && (
    provider !== "claude" || supportsEffortParameter(modelId)
  );
}

function shouldShowThinking(provider: string, modelId: string): boolean {
  return provider === "claude" && supportsThinkingToggle(modelId);
}

/**
 * Model settings section: provider, default model, fallback model, reasoning effort
 * (only when the provider exposes an effort tier), utility model provider/model,
 * diff summary toggle, and CLI paths.
 *
 * Default and fallback pickers merge live `listProviderModels` results with static
 * catalog fallbacks (needed for Cursor, Copilot, and Claude API discovery). Stale
 * saved IDs that disappear from the catalog stay selectable with a warning until the user changes them.
 *
 * Model options update when the provider changes. Switching provider resets the default
 * model to the new provider's first model and clears the fallback. The reasoning level
 * is normalized down when the new model does not support the current tier.
 */
export function ModelSection() {
  const provider = useSettingsStore((s) => s.settings.model.defaults.provider);
  const modelId = useSettingsStore((s) => s.settings.model.defaults.id);
  const fallbackId = useSettingsStore((s) => s.settings.model.defaults.fallbackId);
  const reasoning = useSettingsStore((s) => s.settings.model.defaults.reasoning);
  const contextWindowMode = useSettingsStore(
    (s) => s.settings.model.defaults.contextWindow,
  );
  const thinking = useSettingsStore((s) => s.settings.model.defaults.thinking);
  const codexFastMode = useSettingsStore(
    (s) => s.settings.provider.codex?.fastMode ?? false,
  );
  const utilityProvider = useSettingsStore((s) => s.settings.model.utility.provider);
  const utilityModelId = useSettingsStore((s) => s.settings.model.utility.id);
  const diffSummaryEnabled = useSettingsStore((s) => s.settings.diffSummary.enabled);
  const update = useSettingsStore((s) => s.update);
  const availabilityProviders = useProviderAvailabilityStore((s) => s.providers);
  const availabilityById = useMemo(
    () => new Map<string, ProviderAvailability>(availabilityProviders.map((row) => [row.id, row])),
    [availabilityProviders],
  );

  const providerOptions = useMemo(
    () => MODEL_PROVIDERS.map((p) => buildProviderOption(p, availabilityById.get(p.id))),
    [availabilityById],
  );

  const utilityProviderOptions = useMemo(
    () => [
      {
        value: "",
        label: "Auto",
        disabled: false,
        icon: <Sparkles size={12} className="text-muted-foreground" aria-hidden />,
        title: "Use the default provider above",
      },
      ...MODEL_PROVIDERS.map((p) => buildProviderOption(p, availabilityById.get(p.id))),
    ],
    [availabilityById],
  );

  const activeProvider = MODEL_PROVIDERS.find((p) => p.id === provider);

  // Effective provider for utility model: explicit selection or inherit from default
  const utilityEffectiveProvider = MODEL_PROVIDERS.find(
    (p) => p.id === (utilityProvider || provider),
  );

  const utilityEffectiveId = utilityProvider || provider;
  const dynamicUtilityModels = useProviderModelsStore((s) => s.models[utilityEffectiveId]);
  const utilityModelsLoading = useProviderModelsStore((s) => s.loading[utilityEffectiveId] ?? false);

  const fetchModels = useProviderModelsStore((s) => s.fetchModels);
  const dynamicModels = useProviderModelsStore((s) => s.models[provider]);
  const modelsLoading = useProviderModelsStore((s) => s.loading[provider] ?? false);

  const cliPaths = useSettingsStore((s) => s.settings.provider.cli);
  const dynamicCliPath = getProviderCliPath(provider, cliPaths);
  const utilityDynamicCliPath = getProviderCliPath(utilityEffectiveId, cliPaths);

  useEffect(() => {
    void fetchModels(provider, { force: true });
  }, [provider, dynamicCliPath, fetchModels]);

  useEffect(() => {
    if (!utilityProvider) return;
    void fetchModels(utilityEffectiveId, { force: true });
  }, [utilityProvider, utilityEffectiveId, utilityDynamicCliPath, fetchModels]);


  const mergedCatalogModels = useMemo(
    () => pickProviderModelsForSettings(activeProvider?.models ?? [], dynamicModels),
    [activeProvider, dynamicModels],
  );

  const modelsForDefaultPicker = useMemo(() => {
    const ids = new Set(mergedCatalogModels.map((m) => m.id));
    if (modelId.trim() && !ids.has(modelId)) {
      const orphan: ModelDefinition = {
        id: modelId,
        label: `${modelId} (unlisted)`,
        providerId: provider,
        group: "Saved selection",
      };
      return [orphan, ...mergedCatalogModels];
    }
    return mergedCatalogModels;
  }, [mergedCatalogModels, modelId, provider]);

  const modelsForFallbackPicker = useMemo(() => {
    const ids = new Set(mergedCatalogModels.map((m) => m.id));
    if (fallbackId.trim() && !ids.has(fallbackId)) {
      const orphan: ModelDefinition = {
        id: fallbackId,
        label: `${fallbackId} (unlisted)`,
        providerId: provider,
        group: "Saved selection",
      };
      return [orphan, ...mergedCatalogModels];
    }
    return mergedCatalogModels;
  }, [mergedCatalogModels, fallbackId, provider]);

  const staleDefaultToastSigRef = useRef<string | null>(null);
  useEffect(() => {
    if (modelsLoading || mergedCatalogModels.length === 0) return;
    if (!modelId.trim()) return;
    if (mergedCatalogModels.some((m) => m.id === modelId)) return;
    const sig = `${provider}:${modelId}`;
    if (staleDefaultToastSigRef.current === sig) return;
    staleDefaultToastSigRef.current = sig;
    useToastStore.getState().show(
      "info",
      "Saved model not in catalog",
      `'${modelId}' is missing from the latest ${provider} model list. Pick another model in Settings.`,
      8000,
    );
  }, [modelsLoading, mergedCatalogModels, modelId, provider]);

  const defaultModelStale = isModelStale(modelId, modelsLoading, mergedCatalogModels);
  const fallbackModelStale = isModelStale(fallbackId, modelsLoading, mergedCatalogModels);

  const modelOptions = useMemo(
    () =>
      modelsForDefaultPicker.map((m) => ({
        value: m.id,
        label: m.multiplier != null && m.multiplier !== 1 ? `${m.label} (${m.multiplier}x)` : m.label,
        group: m.group,
      })),
    [modelsForDefaultPicker],
  );

  const fallbackOptions = useMemo(
    () => [
      { value: "", label: "Off", group: undefined },
      ...modelsForFallbackPicker.map((m) => ({
        value: m.id,
        label: m.multiplier != null && m.multiplier !== 1 ? `${m.label} (${m.multiplier}x)` : m.label,
        group: m.group,
      })),
    ],
    [modelsForFallbackPicker],
  );

  const mergedUtilityCatalogModels = useMemo(
    () =>
      pickProviderModelsForSettings(utilityEffectiveProvider?.models ?? [], dynamicUtilityModels),
    [utilityEffectiveProvider, dynamicUtilityModels],
  );

  const modelsForUtilityPicker = useMemo(() => {
    const ids = new Set(mergedUtilityCatalogModels.map((m) => m.id));
    if (utilityModelId.trim() && !ids.has(utilityModelId)) {
      const orphan: ModelDefinition = {
        id: utilityModelId,
        label: `${utilityModelId} (unlisted)`,
        providerId: utilityEffectiveId,
        group: "Saved selection",
      };
      return [orphan, ...mergedUtilityCatalogModels];
    }
    return mergedUtilityCatalogModels;
  }, [mergedUtilityCatalogModels, utilityModelId, utilityEffectiveId]);

  const utilityModelOptions = useMemo(
    () => [
      { value: "", label: "Auto", group: undefined },
      ...modelsForUtilityPicker.map((m) => ({
        value: m.id,
        label: m.multiplier != null && m.multiplier !== 1 ? `${m.label} (${m.multiplier}x)` : m.label,
        group: m.group,
      })),
    ],
    [modelsForUtilityPicker],
  );


  // Gate on provider so Copilot models that share IDs with Codex models
  // don't accidentally take the Codex reasoning branch.
  const codexLevels = useMemo(
    () => (provider === "codex" ? getCodexReasoningLevels(modelId) : null),
    [provider, modelId],
  );

  const reasoningOptions = useMemo(() => {
    if (codexLevels) {
      return codexLevels.map((level) => ({
        value: level,
        label: CODEX_REASONING_LABELS[level] ?? level,
      }));
    }
    if (provider === "copilot") {
      return REASONING_OPTIONS_BASE;
    }
    // Claude: correct tier order is Low, Medium, High, X-High, Max.
    // Tiers above the model's ceiling are disabled.
    return [
      ...REASONING_OPTIONS_BASE,
      { value: "xhigh",      label: "X-High",     disabled: !isXhighEffortModel(modelId) },
      { value: "max",        label: "Max",        disabled: !isMaxEffortModel(modelId) },
    ];
  }, [modelId, codexLevels, provider]);

  const reasoningHint = useMemo(() => {
    if (codexLevels) {
      return "Reasoning effort for Codex models.";
    }
    if (provider === "copilot") {
      return "Reasoning effort passed to the Copilot model. Not all models support all levels.";
    }
    return "Default reasoning level. Max requires Fable 5, Sonnet 5, Opus 4.8/4.7/4.6, or Sonnet 4.6. X-High requires Opus 4.8 or Opus 4.7.";
  }, [codexLevels, provider]);

  const handleProviderChange = (v: string) => {
    void (async () => {
      await useProviderModelsStore.getState().fetchModels(v, { force: true });
      const newProvider = MODEL_PROVIDERS.find((p) => p.id === v);
      const dynamicFirst = useProviderModelsStore.getState().models[v]?.[0];
      const firstModel = dynamicFirst ?? newProvider?.models[0];
      let newReasoning: string = reasoning;
      if (firstModel) {
        const codexLevels = getCodexReasoningLevels(firstModel.id);
        if (codexLevels) {
          newReasoning = codexLevels.includes(reasoning as never)
            ? reasoning
            : (getCodexDefaultReasoningLevel(firstModel.id) ?? "medium");
        } else {
          newReasoning = normalizeReasoningLevelForModel(firstModel.id, reasoning);
        }
      }
      void update({
        model: {
          defaults: {
            provider: v as SettingsProviderId,
            ...(firstModel && { id: firstModel.id, fallbackId: "" }),
            reasoning: newReasoning as ReasoningLevel,
          },
        },
      });
    })();
  };

  const handleModelChange = (v: string) => {
    const codexLevels = getCodexReasoningLevels(v);
    let newReasoning: string = reasoning;
    if (codexLevels) {
      // For Codex models: if the stored level isn't valid for this model, use its default
      if (!codexLevels.includes(reasoning as never)) {
        newReasoning = getCodexDefaultReasoningLevel(v) ?? "medium";
      }
    } else {
      newReasoning = normalizeReasoningLevelForModel(v, reasoning);
    }
    void update({
      model: {
        defaults: {
          id: v,
          ...(newReasoning !== reasoning && { reasoning: newReasoning as ReasoningLevel }),
        },
      },
    });
  };

  return (
    <ModelSettingsContent
      provider={provider}
      modelId={modelId}
      fallbackId={fallbackId}
      reasoning={reasoning}
      contextWindowMode={contextWindowMode}
      thinking={thinking}
      codexFastMode={codexFastMode}
      providerOptions={providerOptions}
      modelOptions={modelOptions}
      fallbackOptions={fallbackOptions}
      modelsLoading={modelsLoading}
      defaultModelStale={defaultModelStale}
      fallbackModelStale={fallbackModelStale}
      showReasoning={shouldShowReasoning(provider, modelId)}
      reasoningOptions={reasoningOptions}
      reasoningHint={reasoningHint}
      showFastMode={provider === "codex"}
      showContextWindow={provider === "claude"}
      showThinking={shouldShowThinking(provider, modelId)}
      utilityProvider={utilityProvider}
      utilityModelId={utilityModelId}
      utilityProviderOptions={utilityProviderOptions}
      utilityModelOptions={utilityModelOptions}
      utilityModelsLoading={utilityModelsLoading}
      diffSummaryEnabled={diffSummaryEnabled}
      onProviderChange={handleProviderChange}
      onModelChange={handleModelChange}
      onFallbackChange={(value) => void update({ model: { defaults: { fallbackId: value } } })}
      onReasoningChange={(value) => update({ model: { defaults: { reasoning: value as ReasoningLevel } } })}
      onFastModeChange={(value) => void update({ provider: { codex: { fastMode: value } } })}
      onContextWindowChange={(value) => update({ model: { defaults: { contextWindow: value as ContextWindowMode } } })}
      onThinkingChange={(value) => update({ model: { defaults: { thinking: value === "on" } } })}
      onUtilityProviderChange={(value) => void update({ model: { utility: { provider: value as SettingsProviderId | "", id: "" } } })}
      onUtilityModelChange={(value) => void update({ model: { utility: { id: value } } })}
      onDiffSummaryChange={(value) => update({ diffSummary: { enabled: value } })}
    />
  );
}

interface ModelSettingsContentProps {
  provider: string;
  modelId: string;
  fallbackId: string;
  reasoning: string;
  contextWindowMode: string;
  thinking: boolean;
  codexFastMode: boolean;
  providerOptions: ProviderOptions;
  modelOptions: ModelPickerOptions;
  fallbackOptions: ModelPickerOptions;
  modelsLoading: boolean;
  defaultModelStale: boolean;
  fallbackModelStale: boolean;
  showReasoning: boolean;
  reasoningOptions: ReasoningOptions;
  reasoningHint: string;
  showFastMode: boolean;
  showContextWindow: boolean;
  showThinking: boolean;
  utilityProvider: string;
  utilityModelId: string;
  utilityProviderOptions: ProviderOptions;
  utilityModelOptions: ModelPickerOptions;
  utilityModelsLoading: boolean;
  diffSummaryEnabled: boolean;
  onProviderChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onFallbackChange: (value: string) => void;
  onReasoningChange: (value: string) => void;
  onFastModeChange: (value: boolean) => void;
  onContextWindowChange: (value: string) => void;
  onThinkingChange: (value: string) => void;
  onUtilityProviderChange: (value: string) => void;
  onUtilityModelChange: (value: string) => void;
  onDiffSummaryChange: (value: boolean) => void;
}

function ModelSettingsContent({
  provider,
  modelId,
  fallbackId,
  reasoning,
  contextWindowMode,
  thinking,
  codexFastMode,
  providerOptions,
  modelOptions,
  fallbackOptions,
  modelsLoading,
  defaultModelStale,
  fallbackModelStale,
  showReasoning,
  reasoningOptions,
  reasoningHint,
  showFastMode,
  showContextWindow,
  showThinking,
  utilityProvider,
  utilityModelId,
  utilityProviderOptions,
  utilityModelOptions,
  utilityModelsLoading,
  diffSummaryEnabled,
  onProviderChange,
  onModelChange,
  onFallbackChange,
  onReasoningChange,
  onFastModeChange,
  onContextWindowChange,
  onThinkingChange,
  onUtilityProviderChange,
  onUtilityModelChange,
  onDiffSummaryChange,
}: ModelSettingsContentProps) {
  return (
    <div data-testid="model-settings-section" className="mx-auto w-full max-w-[88rem] pb-10">
      <header className="mb-8 border-b border-border/45 px-1 pb-6">
        <h1 className="text-2xl leading-7 font-semibold tracking-tight text-foreground">
          Models &amp; providers
        </h1>
        <p className="mt-2 max-w-[65ch] text-sm leading-4 text-muted-foreground">
          Configure the providers and model defaults used across new threads and utility tasks.
        </p>
      </header>

      <div className="space-y-8">
        <ProviderSection />
        <DefaultModelSettings
          provider={provider}
          modelId={modelId}
          fallbackId={fallbackId}
          reasoning={reasoning}
          contextWindowMode={contextWindowMode}
          thinking={thinking}
          codexFastMode={codexFastMode}
          providerOptions={providerOptions}
          modelOptions={modelOptions}
          fallbackOptions={fallbackOptions}
          modelsLoading={modelsLoading}
          defaultModelStale={defaultModelStale}
          fallbackModelStale={fallbackModelStale}
          showReasoning={showReasoning}
          reasoningOptions={reasoningOptions}
          reasoningHint={reasoningHint}
          showFastMode={showFastMode}
          showContextWindow={showContextWindow}
          showThinking={showThinking}
          onProviderChange={onProviderChange}
          onModelChange={onModelChange}
          onFallbackChange={onFallbackChange}
          onReasoningChange={onReasoningChange}
          onFastModeChange={onFastModeChange}
          onContextWindowChange={onContextWindowChange}
          onThinkingChange={onThinkingChange}
        />
        <UtilityModelSettings
          utilityProvider={utilityProvider}
          utilityModelId={utilityModelId}
          utilityProviderOptions={utilityProviderOptions}
          utilityModelOptions={utilityModelOptions}
          utilityModelsLoading={utilityModelsLoading}
          onUtilityProviderChange={onUtilityProviderChange}
          onUtilityModelChange={onUtilityModelChange}
        />
        <SettingsGroup title="AI features" description="Optional model-powered features.">
          <SettingRow
            label="Diff summary"
            configKey="diffSummary.enabled"
            hint="Show the Summarize toggle in the All turns diff."
          >
            <Switch checked={diffSummaryEnabled} onCheckedChange={onDiffSummaryChange} />
          </SettingRow>
        </SettingsGroup>
      </div>
    </div>
  );
}

type DefaultModelSettingsProps = Pick<
  ModelSettingsContentProps,
  | "provider"
  | "modelId"
  | "fallbackId"
  | "reasoning"
  | "contextWindowMode"
  | "thinking"
  | "codexFastMode"
  | "providerOptions"
  | "modelOptions"
  | "fallbackOptions"
  | "modelsLoading"
  | "defaultModelStale"
  | "fallbackModelStale"
  | "showReasoning"
  | "reasoningOptions"
  | "reasoningHint"
  | "showFastMode"
  | "showContextWindow"
  | "showThinking"
  | "onProviderChange"
  | "onModelChange"
  | "onFallbackChange"
  | "onReasoningChange"
  | "onFastModeChange"
  | "onContextWindowChange"
  | "onThinkingChange"
>;

function DefaultModelSettings({
  provider,
  modelId,
  fallbackId,
  reasoning,
  contextWindowMode,
  thinking,
  codexFastMode,
  providerOptions,
  modelOptions,
  fallbackOptions,
  modelsLoading,
  defaultModelStale,
  fallbackModelStale,
  showReasoning,
  reasoningOptions,
  reasoningHint,
  showFastMode,
  showContextWindow,
  showThinking,
  onProviderChange,
  onModelChange,
  onFallbackChange,
  onReasoningChange,
  onFastModeChange,
  onContextWindowChange,
  onThinkingChange,
}: DefaultModelSettingsProps) {
  return (
    <SettingsGroup title="Model defaults" description="Defaults applied when you start a new thread.">
      <SettingRow label="Provider" configKey="model.defaults.provider" hint="AI provider for new threads.">
        <SettingsProviderPicker
          value={provider}
          onChange={onProviderChange}
          options={providerOptions}
          data-testid="settings-default-provider-trigger"
        />
      </SettingRow>
      <SettingRow label="Default model" configKey="model.defaults.id" hint="New threads start with this model.">
        <div className="flex flex-col items-end gap-2">
          <SearchableGroupedPicker
            value={modelId}
            onChange={onModelChange}
            options={modelOptions}
            searchPlaceholder="Search models…"
            loading={modelsLoading}
            data-testid="settings-default-model-trigger"
          />
          {defaultModelStale && (
            <p className="max-w-xs text-right text-xs text-amber-600 dark:text-amber-500">
              This model is not in the current catalog. Sending messages may fail until you choose a listed model.
            </p>
          )}
        </div>
      </SettingRow>
      <SettingRow
        label="Fallback model"
        configKey="model.defaults.fallbackId"
        hint="Used when the primary model is unavailable. Off disables fallback."
      >
        <div className="flex flex-col items-end gap-2">
          <SearchableGroupedPicker
            value={fallbackId}
            onChange={onFallbackChange}
            options={fallbackOptions}
            emptyTriggerLabel="Off"
            searchPlaceholder="Search models…"
            loading={modelsLoading}
            data-testid="settings-fallback-model-trigger"
          />
          {fallbackModelStale && (
            <p className="max-w-xs text-right text-xs text-amber-600 dark:text-amber-500">
              This fallback model is not in the current catalog. Consider turning fallback off or picking a listed model.
            </p>
          )}
        </div>
      </SettingRow>
      {showReasoning && (
        <SettingRow label="Reasoning effort" configKey="model.defaults.reasoning" hint={reasoningHint}>
          <SegControl options={reasoningOptions} value={reasoning} onChange={onReasoningChange} />
        </SettingRow>
      )}
      {showFastMode && (
        <SettingRow
          label="Fast mode"
          configKey="provider.codex.fastMode"
          hint="Sends OpenAI fast service tier on Codex turns when your CLI and account support it (often lower latency; billing follows OpenAI rules)."
        >
          <Switch checked={codexFastMode} onCheckedChange={onFastModeChange} />
        </SettingRow>
      )}
      {showContextWindow && (
        <SettingRow
          label="Context window"
          configKey="model.defaults.contextWindow"
          hint="200k is the standard window. 1M uses the extended beta window on Opus 4.7/4.6 and Sonnet 4.6."
        >
          <SegControl
            options={[
              { value: "200k", label: "200K" },
              { value: "1m", label: "1M", disabled: !supports1MContextWindow(modelId) },
            ]}
            value={contextWindowMode}
            onChange={onContextWindowChange}
          />
        </SettingRow>
      )}
      {showThinking && (
        <SettingRow
          label="Thinking"
          configKey="model.defaults.thinking"
          hint="Enable extended thinking for Haiku 4.5. Effort-tier models ignore this and use the reasoning level instead."
        >
          <SegControl
            options={[
              { value: "off", label: "Off" },
              { value: "on", label: "On" },
            ]}
            value={thinking ? "on" : "off"}
            onChange={onThinkingChange}
          />
        </SettingRow>
      )}
    </SettingsGroup>
  );
}

type UtilityModelSettingsProps = Pick<
  ModelSettingsContentProps,
  | "utilityProvider"
  | "utilityModelId"
  | "utilityProviderOptions"
  | "utilityModelOptions"
  | "utilityModelsLoading"
  | "onUtilityProviderChange"
  | "onUtilityModelChange"
>;

function UtilityModelSettings({
  utilityProvider,
  utilityModelId,
  utilityProviderOptions,
  utilityModelOptions,
  utilityModelsLoading,
  onUtilityProviderChange,
  onUtilityModelChange,
}: UtilityModelSettingsProps) {
  return (
    <SettingsGroup
      title="Utility model"
      description="Provider and model for lightweight tasks such as PR drafts and diff summaries."
    >
      <SettingRow
        label="Provider"
        configKey="model.utility.provider"
        hint="AI provider for lightweight tasks (PR drafts, diff summaries). Auto inherits from the default provider above."
      >
        <SettingsProviderPicker
          value={utilityProvider}
          onChange={onUtilityProviderChange}
          options={utilityProviderOptions}
          data-testid="settings-utility-provider-trigger"
        />
      </SettingRow>
      <SettingRow
        label="Model"
        configKey="model.utility.id"
        hint="Model for utility tasks. Auto selects a provider-appropriate cheap default."
      >
        {utilityProvider ? (
          <SearchableGroupedPicker
            value={utilityModelId}
            onChange={onUtilityModelChange}
            options={utilityModelOptions.map(({ value, label, group }) => ({ value, label, group }))}
            emptyTriggerLabel="Auto"
            searchPlaceholder="Search utility models…"
            loading={utilityModelsLoading}
            data-testid="settings-utility-model-trigger"
          />
        ) : (
          <div className="flex h-8 min-w-[220px] max-w-[280px] items-center rounded-[min(var(--radius-md),12px)] border border-input bg-background px-2.5 text-xs text-muted-foreground select-none">
            Auto
          </div>
        )}
      </SettingRow>
    </SettingsGroup>
  );
}
