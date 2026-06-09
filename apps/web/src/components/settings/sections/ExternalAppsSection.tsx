import { useMemo } from "react";
import { Sparkles } from "lucide-react";
import { useSettingsStore } from "@/stores/settingsStore";
import { useOpenInApps } from "@/hooks/useOpenInApps";
import { openInAppIcon } from "@/components/chat/openInAppIcons";
import type { OpenInApp } from "@/transport/types";
import { SettingRow } from "../SettingRow";
import { SectionHeading } from "../SectionHeading";
import {
  SettingsProviderPicker,
  type SettingsProviderPickOption,
} from "../SettingsProviderPicker";

/** Empty `defaultEditor` selects tier-3 auto-resolution (the "Auto" option). */
const AUTO_VALUE = "";

/**
 * Builds the picker options for the global default open-in app: an "Auto" entry
 * (empty value, tier-3 auto-resolution) first, then every installed app with its
 * registry icon. A saved id that is no longer installed is appended as a
 * selectable "(not installed)" row so a stale default stays visible and clearable
 * instead of silently disappearing.
 *
 * @param apps - All registry apps with detection status, from {@link useOpenInApps}.
 * @param currentValue - The saved `externalApps.defaultEditor` value.
 * @returns Ordered options for {@link SettingsProviderPicker}.
 */
export function buildOpenInAppOptions(
  apps: readonly OpenInApp[],
  currentValue: string,
): SettingsProviderPickOption[] {
  const installed = apps.filter((app) => app.detected);
  const options: SettingsProviderPickOption[] = [
    {
      value: AUTO_VALUE,
      label: "Auto",
      disabled: false,
      icon: <Sparkles size={14} aria-hidden />,
      title: "Resolve to your highest-priority installed editor, then File Explorer",
    },
    ...installed.map((app) => ({
      value: app.id,
      label: app.label,
      disabled: false,
      icon: openInAppIcon(app.iconKey, 14),
    })),
  ];

  if (currentValue && !installed.some((app) => app.id === currentValue)) {
    options.push({
      value: currentValue,
      label: `${currentValue} (not installed)`,
      disabled: false,
      title: "This app was not detected on this system",
    });
  }

  return options;
}

/**
 * External apps settings section: chooses the global default open-in app
 * (`externalApps.defaultEditor`, tier 2 of the three-tier resolution). New
 * threads with no per-thread override open in this app; "Auto" clears the
 * setting and falls back to auto-resolution.
 */
export function ExternalAppsSection() {
  const defaultEditor = useSettingsStore((s) => s.settings.externalApps.defaultEditor);
  const update = useSettingsStore((s) => s.update);
  const apps = useOpenInApps();

  const options = useMemo(
    () => buildOpenInAppOptions(apps, defaultEditor),
    [apps, defaultEditor],
  );

  return (
    <div>
      <SectionHeading>External Apps</SectionHeading>
      <div>
        <SettingRow
          label="Default open-in app"
          configKey="externalApps.defaultEditor"
          hint="New threads open in this app. Auto picks your highest-priority installed editor and falls back to File Explorer."
        >
          <SettingsProviderPicker
            value={defaultEditor}
            onChange={(v) => void update({ externalApps: { defaultEditor: v } })}
            options={options}
            searchPlaceholder="Search apps…"
            searchAriaLabel="Search apps"
            data-testid="settings-default-open-in-trigger"
          />
        </SettingRow>
      </div>
    </div>
  );
}
