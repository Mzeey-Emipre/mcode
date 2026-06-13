import { useMemo } from "react";
import { create } from "zustand";
import type { BrowserTabSet } from "@mcode/contracts";
import { usePreviewFocusStore } from "./previewFocusStore";

/**
 * Live chrome for the active preview page, sourced from `preview:page-status`.
 * Page events flow through that channel rather than `preview:tabs-updated`, so
 * the host-truth {@link BrowserTabSet} lags a tab's live title/url/favicon. The
 * panel publishes this overlay so the rail's page switcher (and the Browser
 * rail glyph) reflect the active page as it navigates, without re-serializing
 * the whole tab set on every favicon tick.
 */
export interface PreviewLiveChrome {
  readonly title: string | null;
  readonly url: string | null;
  readonly favicon: string | null;
}

/** Field-wise equality for two live-chrome values (both may be null). */
function sameLiveChrome(a: PreviewLiveChrome | null, b: PreviewLiveChrome | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.title === b.title && a.url === b.url && a.favicon === b.favicon;
}

/** The minimal slice of the desktop bridge's tab surface this store drives. */
interface PreviewTabsBridgeLike {
  create(
    threadId: string,
    activate: boolean,
  ): Promise<{ ok: true; data: { tabId: string; tabs: BrowserTabSet } } | { ok: false; error: string }>;
  activate(
    threadId: string,
    tabId: string,
  ): Promise<{ ok: true; data: BrowserTabSet } | { ok: false; error: string }>;
  close(
    threadId: string,
    tabId: string,
  ): Promise<{ ok: true; data: BrowserTabSet } | { ok: false; error: string }>;
  closeScope?(
    threadId: string,
  ): Promise<{ ok: true; data: BrowserTabSet } | { ok: false; error: string }>;
}

function bridgeTabs(): PreviewTabsBridgeLike | undefined {
  return window.desktopBridge?.preview?.tabs as PreviewTabsBridgeLike | undefined;
}

/**
 * Overlays the active page's live chrome onto its entry in `tabSet`. Falls back
 * to the tab's own persisted chrome when a live field is null: the per-thread
 * reset blanks live chrome on a thread/url change before the warm guest
 * re-emits its title, so a null overlay must not clobber a loaded page's real
 * title (the bar would otherwise read "New tab" over a live page).
 */
export function overlayDisplaySet(
  tabSet: BrowserTabSet | null,
  live: PreviewLiveChrome | null,
): BrowserTabSet | null {
  if (!tabSet || !tabSet.activeTabId || !live) return tabSet;
  return {
    ...tabSet,
    tabs: tabSet.tabs.map((t) =>
      t.id === tabSet.activeTabId
        ? {
            ...t,
            title: live.title ?? t.title,
            url: live.url ?? t.url,
            faviconUrl: live.favicon ?? t.faviconUrl,
          }
        : t,
    ),
  };
}

interface PreviewTabsState {
  /** Host-truth tab set per scope (threadId, or workspaceId in the threadless shell). */
  readonly tabSetByScope: Record<string, BrowserTabSet | null>;
  /** Live active-page chrome per scope, published by the mounted PreviewPanel. */
  readonly liveChromeByScope: Record<string, PreviewLiveChrome | null>;

  /** Reconcile a scope's tab set against a host snapshot (list / tabs-updated / mutation result). */
  setTabSet: (scopeId: string, set: BrowserTabSet | null) => void;
  /** Publish (or clear) the active page's live chrome for a scope. */
  setLiveChrome: (scopeId: string, chrome: PreviewLiveChrome | null) => void;

  /** Create a new page on the scope's browser and focus the omnibox for it. */
  createPage: (scopeId: string) => Promise<void>;
  /** Activate (switch to) a page within the scope's browser. */
  activatePage: (scopeId: string, tabId: string) => Promise<void>;
  /**
   * Close a page. When it is the scope's last page, {@link ClosePageOptions.onLastClose}
   * fires (the panel uses it to close the Browser tab) before the bridge call,
   * so the tab collapses immediately rather than flashing the host's
   * always-recreated empty fallback.
   */
  closePage: (scopeId: string, tabId: string, opts?: ClosePageOptions) => Promise<void>;
  /** Close every host-owned browser page for a scope and clear renderer mirrors. */
  clearScope: (scopeId: string) => Promise<void>;
}

/** Hooks the store offers callers when a page close empties the browser. */
export interface ClosePageOptions {
  /** Invoked when the closed page was the last one in the scope. */
  readonly onLastClose?: () => void;
}

/**
 * Renderer-side source of truth for the in-app browser's pages, mirroring the
 * host tab set and exposing the page add/close/switch actions the activity rail
 * (the page switcher) and the browser header drive. The host owns tab
 * membership; this store reconciles against its snapshots and routes mutations
 * back through the desktop bridge. Keyed by scope so a browser bound to one
 * thread does not leak pages into a sibling.
 */
export const usePreviewTabsStore = create<PreviewTabsState>((set, get) => ({
  tabSetByScope: {},
  liveChromeByScope: {},

  setTabSet: (scopeId, value) =>
    set((s) => ({
      tabSetByScope: { ...s.tabSetByScope, [scopeId]: value },
    })),

  setLiveChrome: (scopeId, chrome) =>
    set((s) => {
      // The host re-emits page-status many times per second during a load.
      // Bail when the chrome is unchanged so unchanged ticks don't notify
      // subscribers (the rail glyph and the whole RightPanel tree subscribe).
      const prev = s.liveChromeByScope[scopeId] ?? null;
      if (sameLiveChrome(prev, chrome)) return s;
      return { liveChromeByScope: { ...s.liveChromeByScope, [scopeId]: chrome } };
    }),

  createPage: async (scopeId) => {
    const tabs = bridgeTabs();
    if (!tabs) return;
    const r = await tabs.create(scopeId, true);
    if (r.ok) {
      get().setTabSet(scopeId, r.data.tabs);
      // A freshly-created page is empty; drop the cursor into the URL field so
      // the user can type immediately (matches the panel-open shortcut's UX).
      usePreviewFocusStore.getState().requestOmniboxFocus();
    }
  },

  activatePage: async (scopeId, tabId) => {
    const tabs = bridgeTabs();
    if (!tabs) return;
    // The newly-active page has not emitted its live chrome yet; clear the
    // stale overlay so it does not paint the prior page's favicon onto it.
    get().setLiveChrome(scopeId, null);
    const r = await tabs.activate(scopeId, tabId);
    if (r.ok) get().setTabSet(scopeId, r.data);
  },

  closePage: async (scopeId, tabId, opts) => {
    const tabs = bridgeTabs();
    if (!tabs) return;
    const current = get().tabSetByScope[scopeId];
    const isLast = !!current && current.tabs.length <= 1;
    if (isLast) opts?.onLastClose?.();
    get().setLiveChrome(scopeId, null);
    const r = await tabs.close(scopeId, tabId);
    if (!r.ok) return;
    // Closing the last page collapses the Browser tab. The host always recreates
    // a blank fallback page in its returned set, but the tab is gone from the
    // rail, so drop the scope's set rather than leave that fallback as a phantom
    // page; reopening Browser re-seeds it via `list`.
    get().setTabSet(scopeId, isLast ? null : r.data);
  },

  clearScope: async (scopeId) => {
    const tabs = bridgeTabs();
    const r = await tabs?.closeScope?.(scopeId);
    if (r && !r.ok) throw new Error(r.error);
    set((s) => {
      const tabSetByScope = { ...s.tabSetByScope };
      const liveChromeByScope = { ...s.liveChromeByScope };
      delete tabSetByScope[scopeId];
      delete liveChromeByScope[scopeId];
      return { tabSetByScope, liveChromeByScope };
    });
  },
}));

/**
 * The display tab set for a scope: the host-truth set overlaid with the active
 * page's live chrome. Returns null when the scope has no known set (no browser
 * opened yet, or a non-desktop build). Pass null/undefined for a missing scope.
 */
export function usePreviewDisplayTabSet(
  scopeId: string | null | undefined,
): BrowserTabSet | null {
  const tabSet = usePreviewTabsStore((s) => (scopeId ? s.tabSetByScope[scopeId] ?? null : null));
  const live = usePreviewTabsStore((s) => (scopeId ? s.liveChromeByScope[scopeId] ?? null : null));
  // overlayDisplaySet allocates a fresh set when live chrome is present; memoize
  // on the source references so an unchanged tick yields a stable reference and
  // does not defeat downstream memoization of the rail.
  return useMemo(() => overlayDisplaySet(tabSet, live), [tabSet, live]);
}
