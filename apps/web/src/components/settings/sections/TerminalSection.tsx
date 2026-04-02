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
      <h2 className="mb-1 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/50">
        Terminal
      </h2>
      <div>
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
    </div>
  );
}
