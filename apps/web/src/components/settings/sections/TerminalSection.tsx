import { useState } from "react";
import { useSettingsStore } from "@/stores/settingsStore";
import { SettingRow } from "../SettingRow";

/** Terminal emulator settings. */
export function TerminalSection() {
  const scrollback = useSettingsStore((s) => s.settings.terminal.scrollback);
  const update = useSettingsStore((s) => s.update);
  const [local, setLocal] = useState<number | null>(null);
  const display = local ?? scrollback;

  const commit = (v: number) => {
    setLocal(null);
    void update({ terminal: { scrollback: v } });
  };

  return (
    <div>
      <h2 className="mb-0.5 text-[15px] font-semibold tracking-tight text-foreground">Terminal</h2>
      <p className="mb-6 text-xs text-muted-foreground">Terminal emulator settings.</p>

      <SettingRow
        label="Scrollback lines"
        configKey="terminal.scrollback"
        hint="Lines to retain in the buffer. Set to 0 for unlimited."
      >
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={5000}
            step={100}
            value={display}
            onChange={(e) => setLocal(Number(e.target.value))}
            onMouseUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
            onKeyUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
            onTouchEnd={(e) => commit(Number((e.target as HTMLInputElement).value))}
            className="flex-1"
          />
          <span className="w-10 text-right font-mono text-xs text-foreground">{display}</span>
        </div>
      </SettingRow>
    </div>
  );
}
