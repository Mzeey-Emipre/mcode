import { useState } from "react";
import { useSettingsStore } from "@/stores/settingsStore";
import { SettingRow } from "../SettingRow";

/**
 * Server settings section: V8 heap size. Changes apply after the server restarts.
 */
export function ServerSection() {
  const heapMb = useSettingsStore((s) => s.settings.server.memory.heapMb);
  const update = useSettingsStore((s) => s.update);
  const [local, setLocal] = useState<number | null>(null);
  const display = local ?? heapMb;

  const commit = (v: number) => {
    setLocal(null);
    void update({ server: { memory: { heapMb: v } } });
  };

  return (
    <div>
      <h2 className="mb-0.5 text-[15px] font-semibold tracking-tight text-foreground">Server</h2>
      <p className="mb-6 text-xs text-muted-foreground">
        Server process settings. Changes apply after restart.
      </p>

      <SettingRow
        label="Heap memory"
        configKey="server.memory.heapMb"
        hint="V8 max old space in MB. Valid range: 64–8192."
      >
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={64}
            max={2048}
            step={64}
            value={display}
            onChange={(e) => setLocal(Number(e.target.value))}
            onMouseUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
            onKeyUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
            onTouchEnd={(e) => commit(Number((e.target as HTMLInputElement).value))}
            className="flex-1"
          />
          <span className="w-14 text-right font-mono text-xs text-foreground">{display} MB</span>
        </div>
        <p className="mt-2 text-xs text-muted-foreground/60">
          Override via{" "}
          <code className="font-mono text-[10px]">MCODE_SERVER_HEAP_MB</code> env variable.
        </p>
      </SettingRow>
    </div>
  );
}
