import { useSettingsStore } from "@/stores/settingsStore";
import { SettingRow } from "../SettingRow";
import { SegControl } from "../SegControl";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { SectionHeading } from "../SectionHeading";
import type { NamingMode } from "@mcode/contracts";

/**
 * Worktree settings section: branch naming strategy and AI name confirmation.
 * AI naming and confirmation are disabled until the feature ships.
 */
export function WorktreeSection() {
  const namingMode = useSettingsStore((s) => s.settings.worktree.naming.mode);
  const aiConfirmation = useSettingsStore((s) => s.settings.worktree.naming.aiConfirmation);
  const update = useSettingsStore((s) => s.update);

  return (
    <div>
      <SectionHeading>Worktrees</SectionHeading>
      <div>
      <SettingRow
        label="Branch naming"
        configKey="worktree.naming.mode"
        hint="How branch names are generated for new worktrees."
      >
        <SegControl
          options={[
            { value: "auto", label: "Auto" },
            { value: "custom", label: "Custom" },
            { value: "ai", label: "AI", disabled: true, title: "Coming soon" },
          ]}
          value={namingMode}
          onChange={(v) => update({ worktree: { naming: { mode: v as NamingMode } } })}
        />
      </SettingRow>

      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger render={<div />}>
            <SettingRow
              configKey="worktree.naming.aiConfirmation"
              label="Confirm AI names"
              hint="Prompt before using an AI-generated branch name."
              className="opacity-30"
            >
              <Switch
                disabled
                checked={aiConfirmation}
                onCheckedChange={(v) => update({ worktree: { naming: { aiConfirmation: v } } })}
              />
            </SettingRow>
          </TooltipTrigger>
          <TooltipContent>Coming soon</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      </div>
    </div>
  );
}
