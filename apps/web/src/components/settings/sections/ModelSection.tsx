import { useSettingsStore } from "@/stores/settingsStore";
import { MODEL_PROVIDERS, isMaxEffortModel } from "@/lib/model-registry";
import { SettingRow } from "../SettingRow";
import { SegControl } from "../SegControl";
import type { SettingsProviderId, ReasoningLevel } from "@mcode/contracts";

/** All provider options. Coming-soon providers are rendered disabled. */
const PROVIDER_OPTIONS = MODEL_PROVIDERS.map((p) => ({
  value: p.id,
  label: p.name,
  disabled: p.comingSoon,
}));

/**
 * Model settings section: provider, default model, fallback model, and reasoning effort.
 * Model options update when the provider changes.
 */
export function ModelSection() {
  const provider = useSettingsStore((s) => s.settings.model.defaults.provider);
  const modelId = useSettingsStore((s) => s.settings.model.defaults.id);
  const fallbackId = useSettingsStore((s) => s.settings.model.defaults.fallbackId);
  const reasoning = useSettingsStore((s) => s.settings.model.defaults.reasoning);
  const update = useSettingsStore((s) => s.update);

  const activeProvider = MODEL_PROVIDERS.find((p) => p.id === provider);
  const modelOptions = (activeProvider?.models ?? []).map((m) => ({
    value: m.id,
    label: m.label,
  }));
  const fallbackOptions = [{ value: "", label: "Off" }, ...modelOptions];

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
        <SegControl
          options={PROVIDER_OPTIONS}
          value={provider}
          onChange={(v) =>
            update({ model: { defaults: { provider: v as SettingsProviderId } } })
          }
        />
      </SettingRow>

      <SettingRow
        label="Default model"
        configKey="model.defaults.id"
        hint="New threads start with this model."
      >
        <SegControl
          options={modelOptions}
          value={modelId}
          onChange={(v) => update({ model: { defaults: { id: v } } })}
        />
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
          options={[
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
            { value: "max", label: "Max", disabled: !isMaxEffortModel(modelId) },
          ]}
          value={reasoning}
          onChange={(v) =>
            update({ model: { defaults: { reasoning: v as ReasoningLevel } } })
          }
        />
      </SettingRow>
    </div>
  );
}
