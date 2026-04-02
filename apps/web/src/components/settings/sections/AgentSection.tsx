import { useSettingsStore } from "@/stores/settingsStore";
import { SettingRow } from "../SettingRow";
import { SegControl } from "../SegControl";
import { RangeControl } from "../RangeControl";
import { SectionHeading } from "../SectionHeading";
import type { AgentDefaultMode } from "@mcode/contracts";

/**
 * Agent settings section: max concurrent agents, default interaction mode, and permission level.
 */
export function AgentSection() {
  const maxConcurrent = useSettingsStore((s) => s.settings.agent.maxConcurrent);
  const mode = useSettingsStore((s) => s.settings.agent.defaults.mode);
  const permission = useSettingsStore((s) => s.settings.agent.defaults.permission);
  const update = useSettingsStore((s) => s.update);

  return (
    <div>
      <SectionHeading>Agent</SectionHeading>
      <div>
      <SettingRow
        label="Max concurrent agents"
        configKey="agent.maxConcurrent"
        hint="Agents running in parallel. Higher values use more memory."
      >
        <RangeControl
          min={1}
          max={10}
          value={maxConcurrent}
          onCommit={(v) => void update({ agent: { maxConcurrent: v } })}
        />
      </SettingRow>

      <SettingRow
        label="Default mode"
        configKey="agent.defaults.mode"
        hint="Interaction mode for new sessions."
      >
        <SegControl
          options={[
            { value: "plan", label: "Plan" },
            { value: "chat", label: "Chat" },
            { value: "agent", label: "Agent", disabled: true, title: "Coming soon" },
          ]}
          value={mode}
          onChange={(v) => update({ agent: { defaults: { mode: v as AgentDefaultMode } } })}
        />
      </SettingRow>

      <SettingRow
        label="Default permission"
        configKey="agent.defaults.permission"
        hint="Supervised requires approval before file writes."
      >
        <SegControl
          options={[
            { value: "full", label: "Full" },
            { value: "supervised", label: "Supervised" },
          ]}
          value={permission}
          onChange={(v) =>
            update({ agent: { defaults: { permission: v as "full" | "supervised" } } })
          }
        />
      </SettingRow>
      </div>
    </div>
  );
}
