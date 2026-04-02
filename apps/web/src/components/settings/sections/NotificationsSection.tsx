import { useSettingsStore } from "@/stores/settingsStore";
import { SettingRow } from "../SettingRow";
import { Switch } from "@/components/ui/switch";

/**
 * Notifications settings section: toggle for desktop agent-event notifications.
 */
export function NotificationsSection() {
  const enabled = useSettingsStore((s) => s.settings.notifications.enabled);
  const update = useSettingsStore((s) => s.update);

  return (
    <div>
      <h2 className="mb-0.5 text-base font-semibold tracking-tight text-foreground">
        Notifications
      </h2>
      <p className="mb-6 text-xs text-muted-foreground">Desktop notification preferences.</p>

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
  );
}
