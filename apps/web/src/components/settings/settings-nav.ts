import type { ComponentType } from "react";
import { ModelSection } from "./sections/ModelSection";
import { AgentSection } from "./sections/AgentSection";
import { AppearanceSection } from "./sections/AppearanceSection";
import { NotificationsSection } from "./sections/NotificationsSection";
import { TerminalSection } from "@/features/terminal";
import { ExternalAppsSection } from "./sections/ExternalAppsSection";
import { PerformanceSection } from "./sections/PerformanceSection";
import { ThreadsSection } from "./sections/ThreadsSection";
import { KeyboardShortcutsSection } from "./sections/KeyboardShortcutsSection";
import { AboutSection } from "./sections/AboutSection";

/** Available settings pages/sections in the app. */
export type SettingsSection =
  | "model"
  | "agent"
  | "appearance"
  | "notifications"
  | "terminal"
  | "externalApps"
  | "keyboard"
  | "performance"
  | "threads"
  | "about";

/** Represents a navigation group in the settings sidebar. */
export interface NavGroup {
  label: string;
  items: { id: SettingsSection; label: string }[];
}

/** Settings navigation structure grouped by category. */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: "AI",
    items: [
      { id: "model", label: "Model" },
      { id: "agent", label: "Agent" },
    ],
  },
  {
    label: "Interface",
    items: [
      { id: "appearance", label: "Appearance" },
      { id: "keyboard", label: "Keyboard Shortcuts" },
      { id: "notifications", label: "Notifications" },
      { id: "terminal", label: "Terminal" },
      { id: "externalApps", label: "External Apps" },
    ],
  },
  {
    label: "System",
    items: [
      { id: "threads", label: "Threads" },
      { id: "performance", label: "Performance" },
      { id: "about", label: "About" },
    ],
  },
];

/** Maps each settings section to its component. */
export const SECTION_MAP: Record<SettingsSection, ComponentType> = {
  model: ModelSection,
  agent: AgentSection,
  appearance: AppearanceSection,
  notifications: NotificationsSection,
  terminal: TerminalSection,
  externalApps: ExternalAppsSection,
  keyboard: KeyboardShortcutsSection,
  performance: PerformanceSection,
  threads: ThreadsSection,
  about: AboutSection,
};
