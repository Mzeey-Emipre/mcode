import { useMemo } from "react";
import { useSettingsStore } from "@/stores/settingsStore";
import { MODEL_PROVIDERS, isMaxEffortModel, normalizeReasoningLevelForModel } from "@/lib/model-registry";
import { SettingRow } from "../SettingRow";
import { SegControl } from "../SegControl";
import type { SettingsProviderId, ReasoningLevel } from "@mcode/contracts";

/** All provider options. Coming-soon providers are rendered disabled. */
const PROVIDER_OPTIONS = MODEL_PROVIDERS.map((p) => ({
  value: p.id,
  label: p.name,
  disabled: p.comingSoon,
}));

const REASONING_OPTIONS_BASE = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

/**
 * Model settings section: provider, default model, fallback model, and reasoning effort.
 * Model options update when the provider changes. Switching provider resets the model
 * and fallback to the new provider's first model. Switching to a non-Opus model clamps
 * the reasoning level from "max" to "high".
 */
export function ModelSection() {
  const provider = useSettingsStore((s) => s.settings.model.defaults.provider);
  const modelId = useSettingsStore((s) => s.settings.model.defaults.id);
  const fallbackId = useSettingsStore((s) => s.settings.model.defaults.fallbackId);
  const reasoning = useSettingsStore((s) => s.settings.model.defaults.reasoning);
  const update = useSettingsStore((s) => s.update);

  const activeProvider = MODEL_PROVIDERS.find((p) => p.id === provider);

  const modelOptions = useMemo(
    () => (activeProvider?.models ?? []).map((m) => ({ value: m.id, label: m.label })),
    [activeProvider],
  );

  const fallbackOptions = useMemo(
    () => [{ value: "", label: "Off" }, ...modelOptions],
    [modelOptions],
  );

  const reasoningOptions = useMemo(
    () => [
      ...REASONING_OPTIONS_BASE,
      { value: "max", label: "Max", disabled: !isMaxEffortModel(modelId) },
    ],
    [modelId],
  );

  const handleProviderChange = (v: string) => {
    const newProvider = MODEL_PROVIDERS.find((p) => p.id === v);
    const firstModel = newProvider?.models[0];
    void update({
      model: {
        defaults: {
          provider: v as SettingsProviderId,
          ...(firstModel && { id: firstModel.id, fallbackId: "" }),
        },
      },
    });
  };

  const handleModelChange = (v: string) => {
    const clamped = normalizeReasoningLevelForModel(v, reasoning);
    void update({
      model: {
        defaults: {
          id: v,
          ...(clamped !== reasoning && { reasoning: clamped }),
        },
      },
    });
  };

  return (
    <div>
      <h2 className="mb-0.5 text-[15px] font-semibold tracking-tight text-foreground">Model</h2>
      <p className="mb-6 text-xs text-muted-foreground">
        Provider, model, and inference defaults for new threads.
      </p>

      <SettingRow
        label="Provider"
        configKey="model.defaults.provider"
        hint="AI provider for new threads."
      >
        <SegControl options={PROVIDER_OPTIONS} value={provider} onChange={handleProviderChange} />
      </SettingRow>

      <SettingRow
        label="Default model"
        configKey="model.defaults.id"
        hint="New threads start with this model."
      >
        <SegControl options={modelOptions} value={modelId} onChange={handleModelChange} />
      </SettingRow>

      <SettingRow
        label="Fallback model"
        configKey="model.defaults.fallbackId"
        hint="Used when the primary model is unavailable. Off disables fallback."
      >
        <SegControl
          options={fallbackOptions}
          value={fallbackId}
          onChange={(v) => update({ model: { defaults: { fallbackId: v } } })}
        />
      </SettingRow>

      <SettingRow
        label="Reasoning effort"
        configKey="model.defaults.reasoning"
        hint="Default reasoning level. Max requires Opus 4.6."
      >
        <SegControl
          options={reasoningOptions}
          value={reasoning}
          onChange={(v) =>
            update({ model: { defaults: { reasoning: v as ReasoningLevel } } })
          }
        />
      </SettingRow>
    </div>
  );
}
