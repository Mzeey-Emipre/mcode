import { useState } from "react";
import { useSettingsStore } from "@/stores/settingsStore";
import { SettingRow } from "../SettingRow";
import { SegControl } from "../SegControl";
import type { AgentDefaultMode } from "@mcode/contracts";

/**
 * Agent settings section: max concurrent agents, default interaction mode, and permission level.
 */
export function AgentSection() {
  const maxConcurrent = useSettingsStore((s) => s.settings.agent.maxConcurrent);
  const mode = useSettingsStore((s) => s.settings.agent.defaults.mode);
  const permission = useSettingsStore((s) => s.settings.agent.defaults.permission);
  const update = useSettingsStore((s) => s.update);
  const [localMax, setLocalMax] = useState<number | null>(null);
  const displayMax = localMax ?? maxConcurrent;

  const commitMax = (v: number) => {
    setLocalMax(null);
    void update({ agent: { maxConcurrent: v } });
  };

  return (
    <div>
      <h2 className="mb-0.5 text-[15px] font-semibold tracking-tight text-foreground">Agent</h2>
      <p className="mb-6 text-xs text-muted-foreground">
        Concurrency and defaults for new agent sessions.
      </p>

      <SettingRow
        label="Max concurrent agents"
        configKey="agent.maxConcurrent"
        hint="Agents running in parallel. Higher values use more memory."
      >
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={1}
            max={Math.max(displayMax, 10)}
            value={displayMax}
            onChange={(e) => setLocalMax(Number(e.target.value))}
            onMouseUp={(e) => commitMax(Number((e.target as HTMLInputElement).value))}
            onKeyUp={(e) => commitMax(Number((e.target as HTMLInputElement).value))}
            onTouchEnd={(e) => commitMax(Number((e.target as HTMLInputElement).value))}
            className="flex-1"
          />
          <span className="w-6 text-center font-mono text-xs text-foreground">{displayMax}</span>
        </div>
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
            { value: "agent", label: "Agent" },
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
  );
}
