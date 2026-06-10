import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useDiffStore, type RightPanelTab } from "@/stores/diffStore";
import { PANEL_TAB_TYPES } from "@/lib/panel-tabs";

/** Whether a tab type only makes sense once a thread exists (Scope, and Review until it goes dual-scope). */
function tabNeedsThread(tab: RightPanelTab): boolean {
  return PANEL_TAB_TYPES.find((type) => type.id === tab)?.needsThread ?? false;
}

/**
 * Summon a right-panel tab from a keyboard shortcut: create-or-focus the tab
 * (opening the panel if it is closed), refocus it if it is open but inactive,
 * and hide the panel if it is already the active tab. One key thus toggles its
 * surface. See ADR-0004 and issue #612.
 *
 * Thread-only tabs (Scope, and Review until it goes dual-scope) have nothing to
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

  const {
    getRightPanel,
    getRightPanelVisible,
    showRightPanel,
    setRightPanelTab,
    hideRightPanel,
  } = useDiffStore.getState();
  const panel = getRightPanel(wid);

  if (!getRightPanelVisible(wid, tid)) {
    showRightPanel(wid, tid);
    setRightPanelTab(wid, tab);
    onFocus?.();
  } else if (panel.activeTab !== tab) {
    setRightPanelTab(wid, tab);
    onFocus?.();
  } else {
    hideRightPanel(wid, tid);
  }
}
