import { useSettingsStore } from "@/stores/settingsStore";
import { SettingRow } from "../SettingRow";
import { Switch } from "@/components/ui/switch";

/** Desktop notification preferences. */
export function NotificationsSection() {
  const enabled = useSettingsStore((s) => s.settings.notifications.enabled);
  const update = useSettingsStore((s) => s.update);

  return (
    <div>
      <h2 className="mb-0.5 text-[15px] font-semibold tracking-tight text-foreground">
        Notifications
      </h2>
      <p className="mb-6 text-xs text-muted-foreground">Desktop notification preferences.</p>

      <SettingRow label="Notifications" configKey="notifications.enabled">
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            Show desktop notifications for agent events.
          </p>
          <Switch
            checked={enabled}
            onCheckedChange={(v) => update({ notifications: { enabled: v } })}
          />
        </div>
      </SettingRow>
    </div>
  );
}
