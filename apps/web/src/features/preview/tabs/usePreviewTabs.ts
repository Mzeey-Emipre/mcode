import { useCallback, useEffect } from "react";
import type { BrowserTabSet } from "@mcode/contracts";
import {
  usePreviewDisplayTabSet,
  usePreviewTabsStore,
  type ClosePageOptions,
} from "../state/previewTabsStore";

/**
 * Renderer-side subscription + action surface for a scope's in-app browser
 * pages.
 *
 * The host process owns tab membership and the active page; this hook seeds
 * {@link usePreviewTabsStore} from `preview:tabs.list` on mount and reconciles
 * against `preview:tabs-updated` pushes. Mutations route through the store,
 * which calls the desktop bridge and writes the result back. Returns the
 * display tab set (host truth overlaid with the active page's live chrome).
 *
 * A no-op in non-desktop builds (the bridge is absent, so `tabSet` stays null).
 */
export function usePreviewTabs(scopeId: string, workspaceId?: string | null) {
  const exactWorkspaceId = workspaceId ?? scopeId;
  const tabSet = usePreviewTabSet(scopeId, workspaceId);
  const newTab = useCallback(
    () => usePreviewTabsStore.getState().openPage(exactWorkspaceId, scopeId),
    [exactWorkspaceId, scopeId],
  );
  const activateTab = useCallback(
    (tabId: string) => usePreviewTabsStore.getState().activatePage(exactWorkspaceId, scopeId, tabId),
    [exactWorkspaceId, scopeId],
  );
  const closeTab = useCallback(
    (tabId: string, opts?: ClosePageOptions) =>
      usePreviewTabsStore.getState().closePage(exactWorkspaceId, scopeId, tabId, opts),
    [exactWorkspaceId, scopeId],
  );

  return { tabSet, newTab, activateTab, closeTab };
}

/** Keeps Electron Browser tab membership synchronized for an optional panel scope. */
export function usePreviewTabSet(
  scopeId: string | null,
  workspaceId?: string | null,
): BrowserTabSet | null {
  const tabSet = usePreviewDisplayTabSet(scopeId, workspaceId);
  const bridge = window.desktopBridge?.preview?.tabs;

  useEffect(() => {
    if (!bridge || !scopeId) return;
    let cancelled = false;
    const { setTabSet } = usePreviewTabsStore.getState();
    void bridge.list(scopeId, workspaceId ?? undefined).then((r) => {
      if (cancelled) return;
      if (r.ok) setTabSet(workspaceId ?? scopeId, scopeId, r.data);
    });
    const off = bridge.onUpdated((payload: BrowserTabSet) => {
      if (cancelled) return;
      if (payload.threadId === scopeId) setTabSet(workspaceId ?? scopeId, scopeId, payload);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [bridge, scopeId, workspaceId]);
  return tabSet;
}
