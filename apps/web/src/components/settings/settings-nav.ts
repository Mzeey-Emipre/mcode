import type { ComponentType } from "react";
import { ModelSection } from "./sections/ModelSection";
import { AgentSection } from "./sections/AgentSection";
import { WorktreeSection } from "./sections/WorktreeSection";
import { AppearanceSection } from "./sections/AppearanceSection";
import { NotificationsSection } from "./sections/NotificationsSection";
import { TerminalSection } from "./sections/TerminalSection";
import { ExternalAppsSection } from "./sections/ExternalAppsSection";
import { PerformanceSection } from "./sections/PerformanceSection";
import { KeyboardShortcutsSection } from "./sections/KeyboardShortcutsSection";
import { AboutSection } from "./sections/AboutSection";

/** Available settings pages/sections in the app. */
export type SettingsSection =
  | "model"
  | "agent"
  | "worktree"
  | "appearance"
  | "notifications"
  | "terminal"
  | "externalApps"
  | "keyboard"
  | "performance"
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
      { id: "worktree", label: "Worktrees" },
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
      { id: "performance", label: "Performance" },
      { id: "about", label: "About" },
    ],
  },
];

/** Maps each settings section to its component. */
export const SECTION_MAP: Record<SettingsSection, ComponentType> = {
  model: ModelSection,
  agent: AgentSection,
  worktree: WorktreeSection,
  appearance: AppearanceSection,
  notifications: NotificationsSection,
  terminal: TerminalSection,
  externalApps: ExternalAppsSection,
  keyboard: KeyboardShortcutsSection,
  performance: PerformanceSection,
  about: AboutSection,
};
