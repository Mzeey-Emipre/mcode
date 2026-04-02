import { useSettingsStore } from "@/stores/settingsStore";
import { SettingRow } from "../SettingRow";
import { SegControl } from "../SegControl";
import { Switch } from "@/components/ui/switch";
import type { NamingMode } from "@mcode/contracts";

/**
 * Worktree settings section: branch naming strategy and AI name confirmation.
 */
export function WorktreeSection() {
  const namingMode = useSettingsStore((s) => s.settings.worktree.naming.mode);
  const aiConfirmation = useSettingsStore((s) => s.settings.worktree.naming.aiConfirmation);
  const update = useSettingsStore((s) => s.update);

  return (
    <div>
      <h2 className="mb-0.5 text-base font-semibold tracking-tight text-foreground">
        Worktrees
      </h2>
      <p className="mb-6 text-xs text-muted-foreground">Branch naming for new git worktrees.</p>

      <SettingRow
        label="Branch naming"
        configKey="worktree.naming.mode"
        hint="How branch names are generated for new worktrees."
      >
        <SegControl
          options={[
            { value: "auto", label: "Auto" },
            { value: "custom", label: "Custom" },
            { value: "ai", label: "AI" },
          ]}
          value={namingMode}
          onChange={(v) => update({ worktree: { naming: { mode: v as NamingMode } } })}
        />
      </SettingRow>

      <SettingRow
        configKey="worktree.naming.aiConfirmation"
        label="Confirm AI names"
        hint="Prompt before using an AI-generated branch name."
      >
        <Switch
          checked={aiConfirmation}
          onCheckedChange={(v) => update({ worktree: { naming: { aiConfirmation: v } } })}
        />
      </SettingRow>
    </div>
  );
}
