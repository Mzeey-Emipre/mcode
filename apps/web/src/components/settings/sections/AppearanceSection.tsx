import { useSettingsStore } from "@/stores/settingsStore";
import { SettingRow } from "../SettingRow";
import { SegControl } from "../SegControl";
import type { Theme } from "@mcode/contracts";

/**
 * Appearance settings section: color theme preference.
 */
export function AppearanceSection() {
  const theme = useSettingsStore((s) => s.settings.appearance.theme);
  const update = useSettingsStore((s) => s.update);

  return (
    <div>
      <h2 className="mb-1 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/50">
        Appearance
      </h2>
      <div>
      <SettingRow
        label="Theme"
        configKey="appearance.theme"
        hint="Color scheme for the interface."
      >
        <SegControl
          options={[
            { value: "system", label: "System" },
            { value: "dark", label: "Dark" },
            { value: "light", label: "Light" },
          ]}
          value={theme}
          onChange={(v) => update({ appearance: { theme: v as Theme } })}
        />
      </SettingRow>
      </div>
    </div>
  );
}
