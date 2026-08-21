/** Public Sub-agents feature surface for app composition and workbench consumers. */
export { SubagentsPanel } from "./roster/SubagentsPanel";
export { projectSubagents } from "./roster/subagent-projection";
export { SubagentIdentityGlyph, getSubagentIdentityPaletteIndex } from "@/components/ui/SubagentIdentityGlyph";
export type { SubagentIdentityGlyphProps } from "@/components/ui/SubagentIdentityGlyph";
export { SubagentLifecycleStatus } from "./lifecycle/SubagentLifecycleStatus";
export type {
  SubagentLifecycleStatusProps,
  SubagentLifecycleTone,
} from "./lifecycle/SubagentLifecycleStatus";
export { SubagentStopControl } from "./lifecycle/SubagentStopControl";
export { SubagentChangeSummary } from "./detail/SubagentChangeSummary";
export { openSubagentsPanel, openSubagentsRoster, openSubagentDetail } from "./detail/open-subagent-detail";
