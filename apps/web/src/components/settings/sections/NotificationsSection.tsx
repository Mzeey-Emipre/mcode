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
      <h2 className="mb-1 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/50">
        Notifications
      </h2>
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
