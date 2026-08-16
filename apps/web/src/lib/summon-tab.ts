import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useDiffStore, type RightPanelTab } from "@/stores/diffStore";
import { useUiStore } from "@/stores/uiStore";
import { PANEL_TAB_TYPES } from "@/lib/panel-tabs";
import { hideRightPanelAdaptive, showRightPanelAdaptive } from "@/lib/right-panel-layout";
import { createTerminalForScope } from "@/lib/ensure-terminal";
import { useTerminalStore } from "@/features/terminal";

/** Whether a tab type only makes sense once a thread exists. */
function tabNeedsThread(tab: RightPanelTab): boolean {
  return PANEL_TAB_TYPES.find((type) => type.id === tab)?.needsThread ?? false;
}

/**
 * Summon a right-panel tab from a keyboard shortcut: create-or-focus the tab
 * (opening the panel if it is closed), refocus it if it is open but inactive,
 * and hide the panel if it is already the active tab. One key thus toggles its
 * surface. See ADR-0004 and issue #612.
 *
 * Thread-only tabs have nothing to
 * show against the workspace root, so their shortcut is inert when no thread is
 * active — this mirrors the availability model, which drops `needsThread` tab
 * types from the threadless creatable set.
 *
 * @param tab The panel tab type to summon.
 * @param onFocus Optional side effect run whenever the tab gains focus (open or
 *   refocus paths, not the hide path). The Browser tab uses this to pull focus
 *   into its URL field.
 */
export function summonTab(tab: RightPanelTab, onFocus?: () => void): void {
  const { activeWorkspaceId: wid, activeThreadId: tid } = useWorkspaceStore.getState();
  if (!wid) return;
  if (tabNeedsThread(tab) && !tid) return;

  const { getRightPanel, getRightPanelVisible, setRightPanelTab, setRightPanelTabInstance } = useDiffStore.getState();
  const ui = useUiStore.getState();
  const panel = getRightPanel(wid, tid);

  const scopeId = tid ?? wid;
  const latestTerminal = useTerminalStore.getState().terminals[scopeId]?.at(-1);
  const focusTerminal = () => {
    if (latestTerminal) {
      setRightPanelTabInstance(wid, tid, `terminal:${latestTerminal.id}`);
      useTerminalStore.getState().setActiveTerminal(scopeId, latestTerminal.id);
      return;
    }
    setRightPanelTab(wid, tid, "terminal");
    createTerminalForScope(scopeId);
  };

  if (ui.primarySurface !== "chat") {
    ui.setPrimarySurface("chat");
    showRightPanelAdaptive(wid, tid);
    if (tab === "terminal") focusTerminal(); else setRightPanelTab(wid, tid, tab);
    onFocus?.();
    return;
  }

  if (!getRightPanelVisible(wid, tid)) {
    showRightPanelAdaptive(wid, tid);
    if (tab === "terminal") focusTerminal(); else setRightPanelTab(wid, tid, tab);
    onFocus?.();
  } else if (!panel.openTabs.includes(tab) || panel.activeTab !== tab) {
    if (tab === "terminal") focusTerminal(); else setRightPanelTab(wid, tid, tab);
    onFocus?.();
  } else {
    hideRightPanelAdaptive(wid, tid);
  }
}
