import { useSettingsStore } from "@/stores/settingsStore";
import { SettingRow } from "../SettingRow";
import { RangeControl } from "../RangeControl";

/**
 * Server settings section: V8 heap size. Changes apply after the server restarts.
 */
export function ServerSection() {
  const heapMb = useSettingsStore((s) => s.settings.server.memory.heapMb);
  const update = useSettingsStore((s) => s.update);

  return (
    <div>
      <h2 className="mb-1 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/50">
        Server
      </h2>
      <div>
      <SettingRow
        label="Heap memory"
        configKey="server.memory.heapMb"
        hint="V8 max old space in MB (64–8192). Override via MCODE_SERVER_HEAP_MB. Changes apply after restart."
      >
        <RangeControl
          min={64}
          max={2048}
          step={64}
          value={heapMb}
          onCommit={(v) => void update({ server: { memory: { heapMb: v } } })}
          formatValue={(v) => `${v} MB`}
        />
      </SettingRow>
      </div>
    </div>
  );
}
