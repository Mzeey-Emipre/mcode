import { useSettingsStore } from "@/stores/settingsStore";
import { SettingRow } from "../SettingRow";
import { SegControl } from "../SegControl";
import { RangeControl } from "../RangeControl";
import { SectionHeading } from "../SectionHeading";
import type { AgentDefaultMode } from "@mcode/contracts";

/**
 * Agent settings section: concurrency, defaults, and per-session guardrails.
 */
export function AgentSection() {
  const maxConcurrent = useSettingsStore((s) => s.settings.agent.maxConcurrent);
  const mode = useSettingsStore((s) => s.settings.agent.defaults.mode);
  const permission = useSettingsStore((s) => s.settings.agent.defaults.permission);
  const maxBudgetUsd = useSettingsStore((s) => s.settings.agent.guardrails.maxBudgetUsd);
  const maxTurns = useSettingsStore((s) => s.settings.agent.guardrails.maxTurns);
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

      <div className="mt-6 mb-1 flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/50">
          Guardrails
        </span>
        <span className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest text-amber-400/90">
          Beta
        </span>
      </div>

      <SettingRow
        label="Budget cap"
        configKey="agent.guardrails.maxBudgetUsd"
        hint="Stop the agent when session cost exceeds this USD amount. 0 disables. Claude only. Budget is checked between turns, so actual cost may slightly exceed the cap."
      >
        <RangeControl
          min={0}
          max={50}
          step={1}
          value={maxBudgetUsd}
          onCommit={(v) => void update({ agent: { guardrails: { maxBudgetUsd: v } } })}
          formatValue={(v) => v === 0 ? "Off" : `$${v}`}
        />
      </SettingRow>

      <SettingRow
        label="Max turns"
        configKey="agent.guardrails.maxTurns"
        hint="Stop the agent after this many turns. 0 disables. Claude only."
      >
        <RangeControl
          min={0}
          max={100}
          step={1}
          value={maxTurns}
          onCommit={(v) => void update({ agent: { guardrails: { maxTurns: v } } })}
          formatValue={(v) => v === 0 ? "Off" : `${v}`}
        />
      </SettingRow>
      </div>
    </div>
  );
}
