/** Public Terminal feature surface for workbench composition. */
export {
  TerminalPanel,
  TerminalPoolHost,
  TerminalTabContent,
  TerminalView,
} from "./surfaces";
export {
  TerminalPoolSlot,
  TerminalPoolSlotProvider,
} from "./surfaces/TerminalPoolSlotContext";
export { TerminalSection } from "./settings/TerminalSection";
export { useTerminalSettingsStore } from "./settings/terminalSettingsStore";
export {
  MAX_TERMINALS_PER_SCOPE,
  TERMINAL_PANEL_DEFAULTS,
  useTerminalStore,
} from "./state/terminalStore";
export type {
  ActiveTerminalSession,
  TerminalInstance,
  TerminalSearchOptions,
  TerminalSearchState,
} from "./state/terminalStore";
