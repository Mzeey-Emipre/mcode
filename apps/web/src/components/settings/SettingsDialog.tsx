import { useSettingsStore } from "@/stores/settingsStore";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Settings } from "lucide-react";

export function SettingsDialog() {
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const notifications = useSettingsStore((s) => s.notificationsEnabled);
  const setNotifications = useSettingsStore((s) => s.setNotificationsEnabled);
  const maxAgents = useSettingsStore((s) => s.maxConcurrentAgents);
  const setMaxAgents = useSettingsStore((s) => s.setMaxConcurrentAgents);

  return (
    <Dialog>
      <DialogTrigger
        render={
          <button className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground">
            <Settings size={16} />
          </button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-6 py-4">
          {/* Theme */}
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium text-foreground">
              Theme
            </label>
            <div className="flex gap-2">
              {(["system", "dark", "light"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTheme(t)}
                  className={`rounded-md px-3 py-1.5 text-sm capitalize ${
                    theme === t
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground hover:bg-accent"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {/* Max concurrent agents */}
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium text-foreground">
              Max Concurrent Agents
            </label>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={1}
                max={10}
                value={maxAgents}
                onChange={(e) => setMaxAgents(Number(e.target.value))}
                className="flex-1"
              />
              <span className="w-6 text-center text-sm text-foreground">
                {maxAgents}
              </span>
            </div>
          </div>

          {/* Notifications */}
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium text-foreground">
              Notifications
            </label>
            <button
              onClick={() => setNotifications(!notifications)}
              className={`relative h-5 w-9 rounded-full transition-colors ${
                notifications ? "bg-primary" : "bg-muted"
              }`}
            >
              <span
                className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
                  notifications ? "translate-x-4" : ""
                }`}
              />
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
