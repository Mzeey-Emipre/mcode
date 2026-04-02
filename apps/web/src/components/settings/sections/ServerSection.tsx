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
      <h2 className="mb-0.5 text-base font-semibold tracking-tight text-foreground">Server</h2>
      <p className="mb-6 text-xs text-muted-foreground">
        Server process settings. Changes apply after restart.
      </p>

      <SettingRow
        label="Heap memory"
        configKey="server.memory.heapMb"
        hint="V8 max old space in MB. Valid range: 64–8192."
      >
        <RangeControl
          min={64}
          max={2048}
          step={64}
          value={heapMb}
          onCommit={(v) => void update({ server: { memory: { heapMb: v } } })}
          formatValue={(v) => `${v} MB`}
        />
        <p className="mt-2 text-xs text-muted-foreground/60">
          Override via{" "}
          <code className="font-mono text-[10px]">MCODE_SERVER_HEAP_MB</code> env variable.
        </p>
      </SettingRow>
    </div>
  );
}
