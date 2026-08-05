import { useMemo } from "react";
import { create } from "zustand";
import {
  BROWSER_TAB_INFO_STRING_MAX,
  type BrowserTabInfo,
  type BrowserTabSet,
  type PreviewRenderingHost,
} from "@mcode/contracts";
import { usePreviewFocusStore } from "./previewFocusStore";
import { useBrowserAutomationStore } from "./browserAutomationStore";

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
  open(
    threadId: string,
    options?: {
      readonly activate?: boolean;
      readonly tabId?: string;
      readonly renderingHost?: PreviewRenderingHost;
    },
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

/** Maximum number of renderer-persistent agent web tabs retained per thread. */
export const MAX_PERSISTENT_WEB_TABS_PER_SCOPE = 3;

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
  /** Renderer-owned web tabs that can be activated without a desktop bridge. */
  readonly persistentTabIdsByScope: Record<string, ReadonlySet<string>>;

  /** Reconcile a scope's tab set against a host snapshot (list / tabs-updated / mutation result). */
  setTabSet: (scopeId: string, set: BrowserTabSet | null) => void;
  /** Add or update one bounded renderer-owned web tab without activating it. */
  upsertPersistentTab: (scopeId: string, tab: BrowserTabInfo) => void;
  /** Remove one renderer-owned web tab from its scope projection. */
  removePersistentTab: (scopeId: string, tabId: string) => void;
  /** Publish (or clear) the active page's live chrome for a scope. */
  setLiveChrome: (scopeId: string, chrome: PreviewLiveChrome | null) => void;
  /** Merge renderer-observed chrome into one tab's persisted renderer mirror. */
  updateTabChrome: (scopeId: string, tabId: string, chrome: PreviewLiveChrome) => void;

  /** Open a new page or continue an exact existing page by id. */
  openPage: (scopeId: string, options?: {
    readonly focusOmnibox?: boolean;
    readonly activate?: boolean;
    readonly tabId?: string;
    readonly renderingHost?: PreviewRenderingHost;
  }) => Promise<string | null>;
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

function clearPreviewScopeState(
  state: Pick<PreviewTabsState, "tabSetByScope" | "liveChromeByScope" | "persistentTabIdsByScope">,
  scopeId: string,
  preserveEmptyState: boolean,
): Pick<PreviewTabsState, "tabSetByScope" | "liveChromeByScope" | "persistentTabIdsByScope"> {
  const tabSetByScope = { ...state.tabSetByScope };
  const liveChromeByScope = { ...state.liveChromeByScope };
  const persistentTabIdsByScope = { ...state.persistentTabIdsByScope };
  if (preserveEmptyState) {
    tabSetByScope[scopeId] = null;
    liveChromeByScope[scopeId] = null;
  } else {
    delete tabSetByScope[scopeId];
    delete liveChromeByScope[scopeId];
  }
  delete persistentTabIdsByScope[scopeId];
  return { tabSetByScope, liveChromeByScope, persistentTabIdsByScope };
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
  persistentTabIdsByScope: {},

  setTabSet: (scopeId, value) =>
    set((s) => ({
      tabSetByScope: { ...s.tabSetByScope, [scopeId]: value },
    })),

  upsertPersistentTab: (scopeId, tab) =>
    set((s) => {
      if (
        tab.id.length > BROWSER_TAB_INFO_STRING_MAX.id ||
        tab.threadId.length > BROWSER_TAB_INFO_STRING_MAX.threadId
      ) return s;
      const persistentIds = new Set(s.persistentTabIdsByScope[scopeId] ?? []);
      if (!persistentIds.has(tab.id) && persistentIds.size >= MAX_PERSISTENT_WEB_TABS_PER_SCOPE) return s;
      persistentIds.add(tab.id);
      const current = s.tabSetByScope[scopeId] ?? {
        threadId: scopeId,
        activeTabId: null,
        tabs: [],
      } satisfies BrowserTabSet;
      const nextTab: BrowserTabInfo = {
        ...tab,
        title: tab.title?.slice(0, BROWSER_TAB_INFO_STRING_MAX.title) ?? null,
        url: tab.url?.slice(0, BROWSER_TAB_INFO_STRING_MAX.url) ?? null,
        faviconUrl: tab.faviconUrl?.slice(0, BROWSER_TAB_INFO_STRING_MAX.faviconUrl) ?? null,
        active: current.activeTabId === tab.id,
      };
      const tabs = current.tabs.some((candidate) => candidate.id === tab.id)
        ? current.tabs.map((candidate) => candidate.id === tab.id ? nextTab : candidate)
        : [...current.tabs, nextTab];
      return {
        tabSetByScope: {
          ...s.tabSetByScope,
          [scopeId]: { ...current, tabs },
        },
        persistentTabIdsByScope: {
          ...s.persistentTabIdsByScope,
          [scopeId]: persistentIds,
        },
      };
    }),

  removePersistentTab: (scopeId, tabId) =>
    set((s) => {
      const currentIds = s.persistentTabIdsByScope[scopeId];
      if (!currentIds?.has(tabId)) return s;
      const persistentIds = new Set(currentIds);
      persistentIds.delete(tabId);
      const persistentTabIdsByScope = { ...s.persistentTabIdsByScope };
      if (persistentIds.size > 0) persistentTabIdsByScope[scopeId] = persistentIds;
      else delete persistentTabIdsByScope[scopeId];
      const current = s.tabSetByScope[scopeId];
      if (!current) return { persistentTabIdsByScope };
      const tabs = current.tabs.filter((tab) => tab.id !== tabId);
      const activeTabId = current.activeTabId === tabId ? tabs[0]?.id ?? null : current.activeTabId;
      return {
        persistentTabIdsByScope,
        tabSetByScope: {
          ...s.tabSetByScope,
          [scopeId]: {
            ...current,
            activeTabId,
            tabs: tabs.map((tab) => ({ ...tab, active: tab.id === activeTabId })),
          },
        },
      };
    }),

  setLiveChrome: (scopeId, chrome) =>
    set((s) => {
      // The host re-emits page-status many times per second during a load.
      // Bail when the chrome is unchanged so unchanged ticks don't notify
      // subscribers (the rail glyph and the whole RightPanel tree subscribe).
      const prev = s.liveChromeByScope[scopeId] ?? null;
      if (sameLiveChrome(prev, chrome)) return s;
      return { liveChromeByScope: { ...s.liveChromeByScope, [scopeId]: chrome } };
    }),

  updateTabChrome: (scopeId, tabId, chrome) =>
    set((s) => {
      const tabSet = s.tabSetByScope[scopeId] ?? null;
      if (!tabSet) return s;
      let changed = false;
      const tabs = tabSet.tabs.map((tab) => {
        if (tab.id !== tabId) return tab;
        const next = {
          ...tab,
          title: chrome.title ?? tab.title,
          url: chrome.url ?? tab.url,
          faviconUrl: chrome.favicon ?? tab.faviconUrl,
        };
        changed =
          next.title !== tab.title ||
          next.url !== tab.url ||
          next.faviconUrl !== tab.faviconUrl;
        return changed ? next : tab;
      });
      if (!changed) return s;
      return {
        tabSetByScope: {
          ...s.tabSetByScope,
          [scopeId]: { ...tabSet, tabs },
        },
      };
    }),

  openPage: async (scopeId, options) => {
    const tabs = bridgeTabs();
    if (!tabs) return null;
    const activate = options?.activate ?? true;
    const r = await tabs.open(scopeId, {
      activate,
      ...(options?.tabId ? { tabId: options.tabId } : {}),
      ...(options?.renderingHost ? { renderingHost: options.renderingHost } : {}),
    });
    if (r.ok) {
      get().setTabSet(scopeId, r.data.tabs);
      useBrowserAutomationStore.getState().refreshTarget(scopeId, r.data.tabId);
      // A user-created page is empty; drop the cursor into the URL field so the
      // user can type immediately (matches the panel-open shortcut's UX).
      if (!options?.tabId && options?.focusOmnibox !== false && (options?.activate ?? true)) {
        usePreviewFocusStore.getState().requestOmniboxFocus();
      }
      return r.data.tabId;
    }
    return null;
  },

  activatePage: async (scopeId, tabId) => {
    const tabs = bridgeTabs();
    if (!tabs) {
      if (!get().persistentTabIdsByScope[scopeId]?.has(tabId)) return;
      get().setLiveChrome(scopeId, null);
      set((s) => {
        const tabSet = s.tabSetByScope[scopeId];
        if (!tabSet || !tabSet.tabs.some((tab) => tab.id === tabId)) return s;
        return {
          tabSetByScope: {
            ...s.tabSetByScope,
            [scopeId]: {
              ...tabSet,
              activeTabId: tabId,
              tabs: tabSet.tabs.map((tab) => ({ ...tab, active: tab.id === tabId })),
            },
          },
        };
      });
      useBrowserAutomationStore.getState().refreshTarget(scopeId, tabId);
      return;
    }
    // The newly-active page has not emitted its live chrome yet; clear the
    // stale overlay so it does not paint the prior page's favicon onto it.
    get().setLiveChrome(scopeId, null);
    const r = await tabs.activate(scopeId, tabId);
    if (r.ok) {
      get().setTabSet(scopeId, r.data);
      useBrowserAutomationStore.getState().refreshTarget(scopeId, tabId);
    }
  },

  closePage: async (scopeId, tabId, opts) => {
    const tabs = bridgeTabs();
    const current = get().tabSetByScope[scopeId];
    const isLast = !!current && current.tabs.length <= 1;
    const clearLastScopeState = () => {
      set((s) => clearPreviewScopeState(s, scopeId, true));
    };
    if (!tabs) {
      if (!get().persistentTabIdsByScope[scopeId]?.has(tabId)) return;
      if (isLast) {
        clearLastScopeState();
        opts?.onLastClose?.();
        useBrowserAutomationStore.getState().releaseThreadTargets(scopeId);
        return;
      }
      get().setLiveChrome(scopeId, null);
      get().removePersistentTab(scopeId, tabId);
      useBrowserAutomationStore.getState().unregisterTarget(scopeId, tabId);
      return;
    }
    if (isLast) {
      clearLastScopeState();
      opts?.onLastClose?.();
      const r = tabs.closeScope
        ? await tabs.closeScope(scopeId)
        : await tabs.close(scopeId, tabId);
      if (!r.ok) return;
      useBrowserAutomationStore.getState().releaseThreadTargets(scopeId);
      return;
    }
    get().setLiveChrome(scopeId, null);
    const r = await tabs.close(scopeId, tabId);
    if (!r.ok) return;
    useBrowserAutomationStore.getState().unregisterTarget(scopeId, tabId);
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
    useBrowserAutomationStore.getState().releaseThreadTargets(scopeId);
    set((s) => clearPreviewScopeState(s, scopeId, false));
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
