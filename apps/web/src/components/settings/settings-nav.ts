import type { ComponentType } from "react";
import { ModelSection } from "./sections/ModelSection";
import { AgentSection } from "./sections/AgentSection";
import { WorktreeSection } from "./sections/WorktreeSection";
import { AppearanceSection } from "./sections/AppearanceSection";
import { NotificationsSection } from "./sections/NotificationsSection";
import { TerminalSection } from "./sections/TerminalSection";
import { ServerSection } from "./sections/ServerSection";
import { KeyboardShortcutsSection } from "./sections/KeyboardShortcutsSection";

export type SettingsSection =
  | "model"
  | "agent"
  | "worktree"
  | "appearance"
  | "notifications"
  | "terminal"
  | "keyboard"
  | "server";

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
    ],
  },
  {
    label: "System",
    items: [{ id: "server", label: "Server" }],
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
  keyboard: KeyboardShortcutsSection,
  server: ServerSection,
};
