import type { ComponentType } from "react";
import { ModelSection } from "./sections/ModelSection";
import { AgentSection } from "./sections/AgentSection";
import { WorktreeSection } from "./sections/WorktreeSection";
import { ProviderSection } from "./sections/ProviderSection";
import { AppearanceSection } from "./sections/AppearanceSection";
import { NotificationsSection } from "./sections/NotificationsSection";
import { TerminalSection } from "./sections/TerminalSection";
import { ServerSection } from "./sections/ServerSection";

export type SettingsSection =
  | "model"
  | "agent"
  | "worktree"
  | "provider"
  | "appearance"
  | "notifications"
  | "terminal"
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
      { id: "provider", label: "Provider" },
    ],
  },
  {
    label: "Interface",
    items: [
      { id: "appearance", label: "Appearance" },
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
  provider: ProviderSection,
  appearance: AppearanceSection,
  notifications: NotificationsSection,
  terminal: TerminalSection,
  server: ServerSection,
};
