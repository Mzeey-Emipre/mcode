import { create } from "zustand";
import { persist } from "zustand/middleware";

type Theme = "system" | "dark" | "light";

interface SettingsState {
  theme: Theme;
  maxConcurrentAgents: number;
  notificationsEnabled: boolean;

  setTheme: (theme: Theme) => void;
  setMaxConcurrentAgents: (count: number) => void;
  setNotificationsEnabled: (enabled: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      theme: "system",
      maxConcurrentAgents: 5,
      notificationsEnabled: true,

      setTheme: (theme) => set({ theme }),
      setMaxConcurrentAgents: (count) => set({ maxConcurrentAgents: count }),
      setNotificationsEnabled: (enabled) => set({ notificationsEnabled: enabled }),
    }),
    {
      name: "mcode-settings",
    }
  )
);
