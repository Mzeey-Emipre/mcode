import { useSettingsStore } from "@/stores/settingsStore";
import { SettingRow } from "../SettingRow";
import { RangeControl } from "../RangeControl";

/**
 * Terminal settings section: scrollback buffer size.
 */
export function TerminalSection() {
  const scrollback = useSettingsStore((s) => s.settings.terminal.scrollback);
  const update = useSettingsStore((s) => s.update);

  return (
    <div>
      <h2 className="mb-0.5 text-base font-semibold tracking-tight text-foreground">Terminal</h2>
      <p className="mb-6 text-xs text-muted-foreground">Terminal emulator settings.</p>

      <SettingRow
        label="Scrollback lines"
        configKey="terminal.scrollback"
        hint="Lines to retain in the buffer. Set to 0 for unlimited."
      >
        <RangeControl
          min={0}
          max={5000}
          step={100}
          value={scrollback}
          onCommit={(v) => void update({ terminal: { scrollback: v } })}
        />
      </SettingRow>
    </div>
  );
}
