import { useSettingsStore } from "@/stores/settingsStore";
import { SettingRow } from "../SettingRow";
import { SectionHeading } from "../SectionHeading";

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
          <input
            type="text"
            value={codexPath}
            onChange={(e) =>
              void update({ provider: { cli: { codex: e.target.value } } })
            }
            placeholder="codex"
            className="h-7 w-56 rounded border border-border bg-background px-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </SettingRow>
        <SettingRow
          label="Claude CLI path"
          configKey="provider.cli.claude"
          hint="Path to the Claude Code CLI binary. Leave empty to auto-discover from PATH."
        >
          <input
            type="text"
            value={claudePath}
            onChange={(e) =>
              void update({ provider: { cli: { claude: e.target.value } } })
            }
            placeholder="claude"
            className="h-7 w-56 rounded border border-border bg-background px-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </SettingRow>
      </div>
    </div>
  );
}
