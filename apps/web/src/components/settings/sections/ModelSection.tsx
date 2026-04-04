import { useMemo, type ReactNode } from "react";
import { useSettingsStore } from "@/stores/settingsStore";
import { MODEL_PROVIDERS, isMaxEffortModel, normalizeReasoningLevelForModel } from "@/lib/model-registry";
import { SettingRow } from "../SettingRow";
import { SegControl } from "../SegControl";
import { SectionHeading } from "../SectionHeading";
import type { SettingsProviderId, ReasoningLevel } from "@mcode/contracts";
import { cn } from "@/lib/utils";
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

const REASONING_OPTIONS_BASE = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

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
    const clamped = firstModel
      ? normalizeReasoningLevelForModel(firstModel.id, reasoning)
      : reasoning;
    void update({
      model: {
        defaults: {
          provider: v as SettingsProviderId,
          ...(firstModel && { id: firstModel.id, fallbackId: "" }),
          reasoning: clamped,
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

      <div className="mt-8">
        <SectionHeading>CLI Paths</SectionHeading>
        <div>
          <SettingRow
            label="Codex CLI path"
            configKey="provider.cli.codex"
            hint="Path to the Codex CLI binary. Leave empty to auto-discover from PATH."
          >
            <input
              type="text"
              value={codexCliPath}
              onChange={(e) => void update({ provider: { cli: { codex: e.target.value } } })}
              placeholder="codex"
              className={cn(
                "h-7 w-56 rounded border border-border bg-background px-2 text-xs text-foreground",
                "placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring",
              )}
            />
          </SettingRow>
          <SettingRow
            label="Claude CLI path"
            configKey="provider.cli.claude"
            hint="Path to the Claude Code CLI binary. Leave empty to auto-discover from PATH."
          >
            <input
              type="text"
              value={claudeCliPath}
              onChange={(e) => void update({ provider: { cli: { claude: e.target.value } } })}
              placeholder="claude"
              className={cn(
                "h-7 w-56 rounded border border-border bg-background px-2 text-xs text-foreground",
                "placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring",
              )}
            />
          </SettingRow>
        </div>
      </div>
    </div>
  );
}
