import { useSettingsStore } from "@/stores/settingsStore";
import { SettingRow } from "../SettingRow";
import { RangeControl } from "../RangeControl";
import { SectionHeading } from "../SectionHeading";

/**
 * Performance settings section. Exposes runtime-tunable knobs that affect
 * memory and latency trade-offs: server V8 heap size and preview memory-saver
 * tab controls (warm tab limit and idle discard timers).
 */
export function PerformanceSection() {
  const heapMb = useSettingsStore((s) => s.settings.server.memory.heapMb);
  const maxWarm = useSettingsStore((s) => s.settings.preview.memorySaver.maxWarm);
  const bgIdleMs = useSettingsStore((s) => s.settings.preview.memorySaver.bgIdleMs);
  const hiddenIdleMs = useSettingsStore((s) => s.settings.preview.memorySaver.hiddenIdleMs);
  const update = useSettingsStore((s) => s.update);

  return (
    <div>
      <SectionHeading>Performance</SectionHeading>
      <div>
        <SettingRow
          label="Server memory budget"
          configKey="server.memory.heapMb"
          hint="Electron uses this as its V8 old-space cap. Bun uses it as a soft server process-RSS budget for admission and shedding (256–8192 MiB). Electron changes apply after restart; Bun updates apply when saved."
        >
          <RangeControl
            min={256}
            max={8192}
            step={64}
            value={heapMb}
            onCommit={(v) => void update({ server: { memory: { heapMb: v } } })}
            formatValue={(v) => `${v} MB`}
          />
        </SettingRow>
        <SettingRow
          label="Warm preview tabs"
          configKey="preview.memorySaver.maxWarm"
          hint="Most-recently-used background browser tabs kept in memory while the preview panel is hidden. Others are discarded and reload when reopened."
        >
          <RangeControl
            min={1}
            max={20}
            step={1}
            value={maxWarm}
            onCommit={(v) => void update({ preview: { memorySaver: { maxWarm: v } } })}
            formatValue={(v) => `${v} tab${v === 1 ? "" : "s"}`}
          />
        </SettingRow>
        <SettingRow
          label="Background idle before discard"
          configKey="preview.memorySaver.bgIdleMs"
          hint="How long an unfocused preview tab can sit idle (while the panel is visible) before its renderer is discarded to save memory."
        >
          <RangeControl
            min={30_000}
            max={3_600_000}
            step={30_000}
            value={bgIdleMs}
            onCommit={(v) => void update({ preview: { memorySaver: { bgIdleMs: v } } })}
            formatValue={(v) => `${(v / 60_000).toFixed(1).replace(/\.0$/, "")} min`}
          />
        </SettingRow>
        <SettingRow
          label="Hidden-panel trim delay"
          configKey="preview.memorySaver.hiddenIdleMs"
          hint="After the preview panel is hidden, how long to wait before trimming the warm set down to the limit above. A short reshow cancels the trim."
        >
          <RangeControl
            min={5_000}
            max={600_000}
            step={5_000}
            value={hiddenIdleMs}
            onCommit={(v) => void update({ preview: { memorySaver: { hiddenIdleMs: v } } })}
            formatValue={(v) => `${Math.round(v / 1_000)}s`}
          />
        </SettingRow>
      </div>
    </div>
  );
}
