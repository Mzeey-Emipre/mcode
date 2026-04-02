import { useSettingsStore } from "@/stores/settingsStore";
import { SettingRow } from "../SettingRow";
import { Switch } from "@/components/ui/switch";
import { SectionHeading } from "../SectionHeading";

/**
 * Notifications settings section: toggle for desktop agent-event notifications.
 */
export function NotificationsSection() {
  const enabled = useSettingsStore((s) => s.settings.notifications.enabled);
  const update = useSettingsStore((s) => s.update);

  return (
    <div>
      <SectionHeading>Notifications</SectionHeading>
      <div>
      <SettingRow
        label="Notifications"
        configKey="notifications.enabled"
        hint="Show desktop notifications for agent events."
      >
        <Switch
          checked={enabled}
          onCheckedChange={(v) => update({ notifications: { enabled: v } })}
        />
      </SettingRow>
      </div>
    </div>
  );
}
