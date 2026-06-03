import { useSettingsStore } from "@/stores/settingsStore";
import { SettingRow } from "../SettingRow";
import { RangeControl } from "../RangeControl";
import { SectionHeading } from "../SectionHeading";

/**
 * Performance settings section. Exposes runtime-tunable knobs that affect
 * memory and latency trade-offs: server V8 heap size, thread cache size, and
 * preview memory-saver tab controls (warm tab limit and idle discard timers).
 */
export function PerformanceSection() {
  const threadCacheSize = useSettingsStore((s) => s.settings.performance.threadCacheSize);
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
          label="Thread cache size"
          configKey="performance.threadCacheSize"
          hint="Keeps the last N threads in memory for instant switching. 10 is a good default for most workflows. Takes effect immediately."
        >
          <RangeControl
            min={1}
            max={50}
            step={1}
            value={threadCacheSize}
            onCommit={(v) => void update({ performance: { threadCacheSize: v } })}
            formatValue={(v) => `${v} thread${v === 1 ? "" : "s"}`}
          />
        </SettingRow>
        {threadCacheSize <= 3 && (
          <p className="text-xs text-amber-500/80 mt-2 px-0">
            At this size, most thread switches will reload from the server.
          </p>
        )}
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
