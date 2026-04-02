import { useSettingsStore } from "@/stores/settingsStore";
import { SettingRow } from "../SettingRow";
import { RangeControl } from "../RangeControl";
import { SectionHeading } from "../SectionHeading";

/**
 * Server settings section: V8 heap size. Changes apply after the server restarts.
 */
export function ServerSection() {
  const heapMb = useSettingsStore((s) => s.settings.server.memory.heapMb);
  const update = useSettingsStore((s) => s.update);

  return (
    <div>
      <SectionHeading>Server</SectionHeading>
      <div>
      <SettingRow
        label="Heap memory"
        configKey="server.memory.heapMb"
        hint="V8 max old space in MB (64–8192). Override via MCODE_SERVER_HEAP_MB. Changes apply after restart."
      >
        <RangeControl
          min={64}
          max={8192}
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
