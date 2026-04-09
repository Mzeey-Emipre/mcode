import { useMemo, type ReactNode } from "react";
import { useSettingsStore } from "@/stores/settingsStore";
import {
  MODEL_PROVIDERS,
  isMaxEffortModel,
  normalizeReasoningLevelForModel,
  getCodexReasoningLevels,
} from "@/lib/model-registry";
import { SettingRow } from "../SettingRow";
import { SegControl } from "../SegControl";
import { SectionHeading } from "../SectionHeading";
import type { SettingsProviderId, ReasoningLevel } from "@mcode/contracts";
import { Input } from "@/components/ui/input";
import { ChevronDown } from "lucide-react";
import {
  ClaudeIcon,
  CodexIcon,
  CursorProviderIcon,
  OpenCodeIcon,
  GeminiIcon,
} from "@/components/chat/ProviderIcons";

/** Maps provider id to its brand icon component. */
const PROVIDER_ICONS: Record<string, ReactNode> = {
  claude: <ClaudeIcon size={12} />,
  codex: <CodexIcon size={12} />,
  cursor: <CursorProviderIcon size={12} />,
  opencode: <OpenCodeIcon size={12} />,
  gemini: <GeminiIcon size={12} />,
};

/** All provider options with icons. Coming-soon providers show a tooltip. */
const PROVIDER_OPTIONS = MODEL_PROVIDERS.map((p) => ({
  value: p.id,
  label: p.name,
  disabled: p.comingSoon,
  icon: PROVIDER_ICONS[p.id],
  title: p.comingSoon ? "Coming soon" : undefined,
}));

/** Provider options for PR draft: "Auto" plus providers that support one-shot completion. */
const PR_DRAFT_PROVIDER_OPTIONS = [
  { value: "", label: "Auto" },
  ...MODEL_PROVIDERS.filter((p) => p.supportsCompletion).map((p) => ({
    value: p.id,
    label: p.name,
    disabled: p.comingSoon,
    icon: PROVIDER_ICONS[p.id],
    title: p.comingSoon ? "Coming soon" : undefined,
  })),
];

const REASONING_OPTIONS_BASE = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

/** Codex reasoning effort labels mapped from SDK level names. */
const CODEX_REASONING_LABELS: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
};

/**
 * Model settings section: provider, default model, fallback model, and reasoning effort.
 * Model options update when the provider changes. Switching provider resets the default
 * model to the new provider's first model and clears the fallback. Switching to a
 * non-Opus model clamps the reasoning level from "max" to "high".
 */
export function ModelSection() {
  const provider = useSettingsStore((s) => s.settings.model.defaults.provider);
  const modelId = useSettingsStore((s) => s.settings.model.defaults.id);
  const fallbackId = useSettingsStore((s) => s.settings.model.defaults.fallbackId);
  const reasoning = useSettingsStore((s) => s.settings.model.defaults.reasoning);
  const codexCliPath = useSettingsStore((s) => s.settings.provider.cli.codex);
  const claudeCliPath = useSettingsStore((s) => s.settings.provider.cli.claude);
  const prDraftProvider = useSettingsStore((s) => s.settings.prDraft.provider);
  const prDraftModel = useSettingsStore((s) => s.settings.prDraft.model);
  const update = useSettingsStore((s) => s.update);

  const activeProvider = MODEL_PROVIDERS.find((p) => p.id === provider);

  // Effective provider for PR draft: explicit selection or inherit from default
  const prDraftEffectiveProvider = MODEL_PROVIDERS.find(
    (p) => p.id === (prDraftProvider || provider),
  );

  const modelOptions = useMemo(
    () => (activeProvider?.models ?? []).map((m) => ({ value: m.id, label: m.label })),
    [activeProvider],
  );

  const fallbackOptions = useMemo(
    () => [{ value: "", label: "Off" }, ...modelOptions],
    [modelOptions],
  );

  // PR draft model options: "Auto" (provider default) + all models for the effective provider
  const prDraftModelOptions = useMemo(
    () => [
      { value: "", label: "Auto" },
      ...(prDraftEffectiveProvider?.models ?? []).map((m) => ({ value: m.id, label: m.label })),
    ],
    [prDraftEffectiveProvider],
  );

  const codexLevels = useMemo(() => getCodexReasoningLevels(modelId), [modelId]);

  const reasoningOptions = useMemo(() => {
    if (codexLevels) {
      // Codex model: show its specific supported levels
      return codexLevels.map((level) => ({
        value: level,
        label: CODEX_REASONING_LABELS[level] ?? level,
      }));
    }
    // Standard Claude reasoning levels
    return [
      ...REASONING_OPTIONS_BASE,
      { value: "max", label: "Max", disabled: !isMaxEffortModel(modelId) },
    ];
  }, [modelId, codexLevels]);

  const reasoningHint = useMemo(() => {
    if (codexLevels) {
      return codexLevels.includes("xhigh")
        ? "Reasoning effort for Codex models. X-High is the maximum tier."
        : "Reasoning effort for Codex models.";
    }
    return "Default reasoning level. Max requires Opus 4.6.";
  }, [codexLevels]);

  const handleProviderChange = (v: string) => {
    const newProvider = MODEL_PROVIDERS.find((p) => p.id === v);
    const firstModel = newProvider?.models[0];
    let newReasoning: string = reasoning;
    if (firstModel) {
      const codexLevels = getCodexReasoningLevels(firstModel.id);
      if (codexLevels) {
        // Switching to Codex: reset to model default if current level isn't valid
        newReasoning = codexLevels.includes(reasoning as never) ? reasoning : "medium";
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
  };

  const handleModelChange = (v: string) => {
    const codexLevels = getCodexReasoningLevels(v);
    let newReasoning: string = reasoning;
    if (codexLevels) {
      // For Codex models: if the stored level isn't valid for this model, use its default
      if (!codexLevels.includes(reasoning as never)) {
        newReasoning = "medium";
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
    <div>
      <SectionHeading>Model</SectionHeading>
      <div>
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
        hint={reasoningHint}
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

      <div className="mt-8">
        <SectionHeading>PR Draft</SectionHeading>
        <div>
          <SettingRow
            label="Provider"
            configKey="prDraft.provider"
            hint="AI provider for PR draft generation. Auto inherits from the default provider above."
          >
            <SegControl
              options={PR_DRAFT_PROVIDER_OPTIONS}
              value={prDraftProvider}
              onChange={(v) => void update({ prDraft: { provider: v as SettingsProviderId | "", model: "" } })}
            />
          </SettingRow>
          <SettingRow
            label="Model"
            configKey="prDraft.model"
            hint="Model for AI-generated PR titles and descriptions. Auto uses a provider-appropriate default."
          >
            {prDraftProvider ? (
              <div className="relative inline-flex w-56">
                <select
                  value={prDraftModel}
                  onChange={(e) => void update({ prDraft: { model: e.target.value } })}
                  className="h-7 w-full appearance-none cursor-pointer rounded-[min(var(--radius-md),12px)] border border-input bg-background pl-2 pr-7 py-0.5 text-xs text-foreground focus-visible:border-ring focus-visible:outline-none"
                >
                  {prDraftModelOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  size={12}
                  className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"
                />
              </div>
            ) : (
              <div className="h-7 w-56 rounded-[min(var(--radius-md),12px)] border border-input bg-background px-2 py-0.5 text-xs text-muted-foreground flex items-center select-none">
                Auto
              </div>
            )}
          </SettingRow>
        </div>
      </div>

      <div className="mt-8">
        <SectionHeading>CLI Paths</SectionHeading>
        <div>
          <SettingRow
            label="Codex CLI path"
            configKey="provider.cli.codex"
            hint="Path to the Codex CLI binary. Leave empty to auto-discover from PATH."
          >
            <Input
              value={codexCliPath}
              onChange={(e) => void update({ provider: { cli: { codex: e.target.value } } })}
              placeholder="codex"
              className="h-7 w-56 text-xs"
            />
          </SettingRow>
          <SettingRow
            label="Claude CLI path"
            configKey="provider.cli.claude"
            hint="Path to the Claude Code CLI binary. Leave empty to auto-discover from PATH."
          >
            <Input
              value={claudeCliPath}
              onChange={(e) => void update({ provider: { cli: { claude: e.target.value } } })}
              placeholder="claude"
              className="h-7 w-56 text-xs"
            />
          </SettingRow>
        </div>
      </div>
    </div>
  );
}
