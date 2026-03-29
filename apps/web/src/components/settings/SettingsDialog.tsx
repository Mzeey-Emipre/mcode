import { useState } from "react";
import { useSettingsStore } from "@/stores/settingsStore";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Settings } from "lucide-react";

/** Settings dialog for configuring user preferences. */
export function SettingsDialog() {
  const theme = useSettingsStore((s) => s.settings.appearance.theme);
  const notifications = useSettingsStore((s) => s.settings.notifications.enabled);
  const maxAgents = useSettingsStore((s) => s.settings.agent.maxConcurrent);
  const update = useSettingsStore((s) => s.update);

  // Local slider state: tracks the in-progress value without triggering RPC on
  // every pixel. The RPC fires only when the user finishes dragging.
  const [localMaxAgents, setLocalMaxAgents] = useState<number | null>(null);
  const displayMaxAgents = localMaxAgents ?? maxAgents;

  return (
    <Dialog>
      <DialogTrigger
        render={
          <button
            className="flex w-full items-center gap-2 rounded p-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Settings"
          >
            <Settings size={16} />
            Settings
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
                  onClick={() => update({ appearance: { theme: t } })}
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
            <label htmlFor="max-agents" className="text-sm font-medium text-foreground">
              Max Concurrent Agents
            </label>
            <div className="flex items-center gap-3">
              <input
                id="max-agents"
                type="range"
                min={1}
                max={10}
                value={displayMaxAgents}
                onChange={(e) => setLocalMaxAgents(Number(e.target.value))}
                onMouseUp={(e) => {
                  const v = Number((e.target as HTMLInputElement).value);
                  setLocalMaxAgents(null);
                  void update({ agent: { maxConcurrent: v } });
                }}
                onKeyUp={(e) => {
                  const v = Number((e.target as HTMLInputElement).value);
                  setLocalMaxAgents(null);
                  void update({ agent: { maxConcurrent: v } });
                }}
                onTouchEnd={(e) => {
                  const v = Number((e.target as HTMLInputElement).value);
                  setLocalMaxAgents(null);
                  void update({ agent: { maxConcurrent: v } });
                }}
                className="flex-1"
              />
              <span className="w-6 text-center text-sm text-foreground">
                {displayMaxAgents}
              </span>
            </div>
          </div>

          {/* Notifications */}
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium text-foreground">
              Notifications
            </label>
            <button
              role="switch"
              aria-checked={notifications}
              onClick={() => update({ notifications: { enabled: !notifications } })}
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
