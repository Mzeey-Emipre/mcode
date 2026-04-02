import { useSettingsStore } from "@/stores/settingsStore";
import { SettingRow } from "../SettingRow";
import { SegControl } from "../SegControl";
import type { Theme } from "@mcode/contracts";

/** Visual theme settings. */
export function AppearanceSection() {
  const theme = useSettingsStore((s) => s.settings.appearance.theme);
  const update = useSettingsStore((s) => s.update);

  return (
    <div>
      <h2 className="mb-0.5 text-[15px] font-semibold tracking-tight text-foreground">
        Appearance
      </h2>
      <p className="mb-6 text-xs text-muted-foreground">Theme and display preferences.</p>

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
  );
}
