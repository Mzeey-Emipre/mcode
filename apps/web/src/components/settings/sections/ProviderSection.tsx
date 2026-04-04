import { useSettingsStore } from "@/stores/settingsStore";
import { SettingRow } from "../SettingRow";
import { SectionHeading } from "../SectionHeading";
import { Input } from "@/components/ui/input";

/**
 * Provider settings section: CLI binary paths for each AI provider.
 * Empty values use auto-discovery from PATH.
 */
export function ProviderSection() {
  const codexPath = useSettingsStore((s) => s.settings.provider.cli.codex);
  const claudePath = useSettingsStore((s) => s.settings.provider.cli.claude);
  const update = useSettingsStore((s) => s.update);

  return (
    <div>
      <SectionHeading>Provider</SectionHeading>
      <div>
        <SettingRow
          label="Codex CLI path"
          configKey="provider.cli.codex"
          hint="Path to the Codex CLI binary. Leave empty to auto-discover from PATH."
        >
          <Input
            value={codexPath}
            onChange={(e) =>
              void update({ provider: { cli: { codex: e.target.value } } })
            }
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
            value={claudePath}
            onChange={(e) =>
              void update({ provider: { cli: { claude: e.target.value } } })
            }
            placeholder="claude"
            className="h-7 w-56 text-xs"
          />
        </SettingRow>
      </div>
    </div>
  );
}
