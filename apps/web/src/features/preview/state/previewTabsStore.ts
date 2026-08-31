import { useMemo } from "react";
import { create } from "zustand";
import {
  BROWSER_TAB_INFO_STRING_MAX,
  type BrowserTabInfo,
  type BrowserTabSet,
} from "@mcode/contracts";
import { usePreviewFocusStore } from "./previewFocusStore";
import { browserAutomationScopeKey, useBrowserAutomationStore } from "../automation/browserAutomationStore";

/** Stable key for one workspace and preview scope. */
export function previewTabsScopeKey(workspaceId: string, scopeId: string): string {
  return browserAutomationScopeKey(workspaceId, scopeId);
}

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

function sameBrowserTab(a: BrowserTabInfo, b: BrowserTabInfo): boolean {
  return a === b || (
    a.id === b.id &&
    a.threadId === b.threadId &&
    a.title === b.title &&
    a.url === b.url &&
    a.faviconUrl === b.faviconUrl &&
    a.warm === b.warm &&
    a.active === b.active
  );
}

function sameBrowserTabSet(a: BrowserTabSet | null, b: BrowserTabSet | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.threadId === b.threadId &&
    a.activeTabId === b.activeTabId &&
    a.tabs.length === b.tabs.length &&
    a.tabs.every((tab, index) => sameBrowserTab(tab, b.tabs[index]!));
}

/** The minimal slice of the desktop bridge's tab surface this store drives. */
interface PreviewTabsBridgeLike {
  open(
    threadId: string,
    workspaceId: string,
    options?: {
      readonly activate?: boolean;
      readonly tabId?: string;
      readonly initialAddress?: string;
    },
  ): Promise<{ ok: true; data: { tabId: string; tabs: BrowserTabSet } } | { ok: false; error: string }>;
  activate(
    threadId: string,
    workspaceId: string,
    tabId: string,
  ): Promise<{ ok: true; data: BrowserTabSet } | { ok: false; error: string }>;
  updateChrome?(
    threadId: string,
    workspaceId: string,
    tabId: string,
    chrome: {
      readonly title: string | null;
      readonly url: string | null;
      readonly faviconUrl: string | null;
    },
  ): Promise<{ ok: true; data: BrowserTabSet } | { ok: false; error: string }>;
  close(
    threadId: string,
    workspaceId: string,
    tabId: string,
  ): Promise<{ ok: true; data: BrowserTabSet } | { ok: false; error: string }>;
  closeScope?(
    threadId: string,
    workspaceId: string,
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
  setTabSet: (workspaceId: string, scopeId: string, set: BrowserTabSet | null) => void;
  /** Add or update one bounded renderer-owned web tab without activating it. */
  upsertPersistentTab: (workspaceId: string, scopeId: string, tab: BrowserTabInfo) => void;
  /** Remove one renderer-owned web tab from its scope projection. */
  removePersistentTab: (workspaceId: string, scopeId: string, tabId: string) => void;
  /** Publish (or clear) the active page's live chrome for a scope. */
  setLiveChrome: (workspaceId: string, scopeId: string, chrome: PreviewLiveChrome | null) => void;
  /** Merge renderer-observed chrome into one tab's persisted renderer mirror. */
  updateTabChrome: (workspaceId: string, scopeId: string, tabId: string, chrome: PreviewLiveChrome) => void;

  /** Open a new page or continue an exact existing page by id. */
  openPage: (workspaceId: string, scopeId: string, options?: {
    readonly focusOmnibox?: boolean;
    readonly activate?: boolean;
    readonly tabId?: string;
    readonly initialAddress?: string;
  }) => Promise<string | null>;
  /** Activate (switch to) a page within the scope's browser. */
  activatePage: (workspaceId: string, scopeId: string, tabId: string) => Promise<void>;
  /**
   * Close a page. When it is the scope's last page, {@link ClosePageOptions.onLastClose}
   * fires (the panel uses it to close the Browser tab) before the bridge call,
   * so the tab collapses immediately rather than flashing the host's
   * always-recreated empty fallback.
   */
  closePage: (workspaceId: string, scopeId: string, tabId: string, opts?: ClosePageOptions) => Promise<void>;
  /** Close every host-owned browser page for a scope and clear renderer mirrors. */
  clearScope: (workspaceId: string, scopeId: string) => Promise<void>;
}

/** Hooks the store offers callers when a page close empties the browser. */
export interface ClosePageOptions {
  /** Invoked when the closed page was the last one in the scope. */
  readonly onLastClose?: () => void;
}

function clearPreviewScopeState(
  state: Pick<PreviewTabsState, "tabSetByScope" | "liveChromeByScope" | "persistentTabIdsByScope">,
  scopeKey: string,
  preserveEmptyState: boolean,
): Pick<PreviewTabsState, "tabSetByScope" | "liveChromeByScope" | "persistentTabIdsByScope"> {
  const tabSetByScope = { ...state.tabSetByScope };
  const liveChromeByScope = { ...state.liveChromeByScope };
  const persistentTabIdsByScope = { ...state.persistentTabIdsByScope };
  if (preserveEmptyState) {
    tabSetByScope[scopeKey] = null;
    liveChromeByScope[scopeKey] = null;
  } else {
    delete tabSetByScope[scopeKey];
    delete liveChromeByScope[scopeKey];
  }
  delete persistentTabIdsByScope[scopeKey];
  return { tabSetByScope, liveChromeByScope, persistentTabIdsByScope };
}

function hasValidPersistentTabIdentity(tab: BrowserTabInfo): boolean {
  return tab.id.length <= BROWSER_TAB_INFO_STRING_MAX.id &&
    tab.threadId.length <= BROWSER_TAB_INFO_STRING_MAX.threadId;
}

function storedPersistentTab(tab: BrowserTabInfo, active: boolean): BrowserTabInfo {
  return {
    ...tab,
    title: tab.title?.slice(0, BROWSER_TAB_INFO_STRING_MAX.title) ?? null,
    url: tab.url?.slice(0, BROWSER_TAB_INFO_STRING_MAX.url) ?? null,
    faviconUrl: tab.faviconUrl?.slice(0, BROWSER_TAB_INFO_STRING_MAX.faviconUrl) ?? null,
    active,
  };
}

function replaceOrAppendTab(tabs: readonly BrowserTabInfo[], tab: BrowserTabInfo): BrowserTabInfo[] {
  return tabs.some((candidate) => candidate.id === tab.id)
    ? tabs.map((candidate) => candidate.id === tab.id ? tab : candidate)
    : [...tabs, tab];
}

function shouldFocusOpenedPage(options: Parameters<PreviewTabsState["openPage"]>[2]): boolean {
  return !options?.tabId && options?.focusOmnibox !== false && (options?.activate ?? true);
}

/**
 * Renderer-side source of truth for the in-app browser's pages, mirroring the
 * host tab set and exposing the page add/close/switch actions the activity rail
 * (the page switcher) and the browser header drive. The host owns tab
 * membership; this store reconciles against its snapshots and routes mutations
 * back through the desktop bridge. Keyed by scope so a browser bound to one
 * thread does not leak pages into a sibling.
 */
export const usePreviewTabsStore = create<PreviewTabsState>((set, get) => {
  const releaseScopeTargets = (workspaceId: string, scopeId: string): void => {
    useBrowserAutomationStore.getState().releaseThreadTargets(workspaceId, scopeId);
  };
  const closePersistentPage = async (
    workspaceId: string,
    scopeId: string,
    tabId: string,
    options: ClosePageOptions | undefined,
  ): Promise<void> => {
    const scopeKey = previewTabsScopeKey(workspaceId, scopeId);
    if (!get().persistentTabIdsByScope[scopeKey]?.has(tabId)) return;
    const current = get().tabSetByScope[scopeKey];
    if (!current || current.tabs.length > 1) {
      get().setLiveChrome(workspaceId, scopeId, null);
      get().removePersistentTab(workspaceId, scopeId, tabId);
      useBrowserAutomationStore.getState().unregisterTarget(workspaceId, scopeId, tabId);
      return;
    }
    set((state) => clearPreviewScopeState(state, scopeKey, true));
    options?.onLastClose?.();
    releaseScopeTargets(workspaceId, scopeId);
  };
  const closeDesktopScope = async (
    tabs: PreviewTabsBridgeLike,
    workspaceId: string,
    scopeId: string,
    tabId: string,
    scopeKey: string,
    options: ClosePageOptions | undefined,
  ): Promise<void> => {
    const result = tabs.closeScope
      ? await tabs.closeScope(scopeId, workspaceId)
      : await tabs.close(scopeId, workspaceId, tabId);
    if (!result.ok) return;
    set((state) => clearPreviewScopeState(state, scopeKey, true));
    releaseScopeTargets(workspaceId, scopeId);
    options?.onLastClose?.();
  };
  const closeDesktopPage = async (
    tabs: PreviewTabsBridgeLike,
    workspaceId: string,
    scopeId: string,
    tabId: string,
    options: ClosePageOptions | undefined,
  ): Promise<void> => {
    const scopeKey = previewTabsScopeKey(workspaceId, scopeId);
    const current = get().tabSetByScope[scopeKey];
    if (current && current.tabs.length <= 1) {
      return closeDesktopScope(tabs, workspaceId, scopeId, tabId, scopeKey, options);
    }
    get().setLiveChrome(workspaceId, scopeId, null);
    const result = await tabs.close(scopeId, workspaceId, tabId);
    if (!result.ok) return;
    useBrowserAutomationStore.getState().unregisterTarget(workspaceId, scopeId, tabId);
    get().setTabSet(workspaceId, scopeId, result.data);
  };

  return {
  tabSetByScope: {},
  liveChromeByScope: {},
  persistentTabIdsByScope: {},

  setTabSet: (workspaceId, scopeId, value) =>
    set((s) => {
      const scopeKey = previewTabsScopeKey(workspaceId, scopeId);
      const previous = s.tabSetByScope[scopeKey] ?? null;
      if (sameBrowserTabSet(previous, value)) return s;
      const activeTabChanged = previous?.activeTabId !== value?.activeTabId;
      return {
        tabSetByScope: { ...s.tabSetByScope, [scopeKey]: value },
        ...(activeTabChanged
          ? { liveChromeByScope: { ...s.liveChromeByScope, [scopeKey]: null } }
          : {}),
      };
    }),

  upsertPersistentTab: (workspaceId, scopeId, tab) =>
    set((s) => {
      const scopeKey = previewTabsScopeKey(workspaceId, scopeId);
      if (!hasValidPersistentTabIdentity(tab)) return s;
      const persistentIds = new Set(s.persistentTabIdsByScope[scopeKey] ?? []);
      if (!persistentIds.has(tab.id) && persistentIds.size >= MAX_PERSISTENT_WEB_TABS_PER_SCOPE) return s;
      persistentIds.add(tab.id);
      const current = s.tabSetByScope[scopeKey] ?? {
        threadId: scopeId,
        activeTabId: null,
        tabs: [],
      } satisfies BrowserTabSet;
      const nextTab = storedPersistentTab(tab, current.activeTabId === tab.id);
      const tabs = replaceOrAppendTab(current.tabs, nextTab);
      return {
        tabSetByScope: {
          ...s.tabSetByScope,
          [scopeKey]: { ...current, tabs },
        },
        persistentTabIdsByScope: {
          ...s.persistentTabIdsByScope,
          [scopeKey]: persistentIds,
        },
      };
    }),

  removePersistentTab: (workspaceId, scopeId, tabId) =>
    set((s) => {
      const scopeKey = previewTabsScopeKey(workspaceId, scopeId);
      const currentIds = s.persistentTabIdsByScope[scopeKey];
      if (!currentIds?.has(tabId)) return s;
      const persistentIds = new Set(currentIds);
      persistentIds.delete(tabId);
      const persistentTabIdsByScope = { ...s.persistentTabIdsByScope };
      if (persistentIds.size > 0) persistentTabIdsByScope[scopeKey] = persistentIds;
      else delete persistentTabIdsByScope[scopeKey];
      const current = s.tabSetByScope[scopeKey];
      if (!current) return { persistentTabIdsByScope };
      const tabs = current.tabs.filter((tab) => tab.id !== tabId);
      const activeTabId = current.activeTabId === tabId ? tabs[0]?.id ?? null : current.activeTabId;
      return {
        persistentTabIdsByScope,
        tabSetByScope: {
          ...s.tabSetByScope,
          [scopeKey]: {
            ...current,
            activeTabId,
            tabs: tabs.map((tab) => ({ ...tab, active: tab.id === activeTabId })),
          },
        },
      };
    }),

  setLiveChrome: (workspaceId, scopeId, chrome) =>
    set((s) => {
      // The host re-emits page-status many times per second during a load.
      // Bail when the chrome is unchanged so unchanged ticks don't notify
      // subscribers (the rail glyph and the whole RightPanel tree subscribe).
      const scopeKey = previewTabsScopeKey(workspaceId, scopeId);
      const prev = s.liveChromeByScope[scopeKey] ?? null;
      if (sameLiveChrome(prev, chrome)) return s;
      return { liveChromeByScope: { ...s.liveChromeByScope, [scopeKey]: chrome } };
    }),

  updateTabChrome: (workspaceId, scopeId, tabId, chrome) => {
    let changed = false;
    let persistedChrome: { title: string | null; url: string | null; faviconUrl: string | null } | null = null;
    set((s) => {
      const scopeKey = previewTabsScopeKey(workspaceId, scopeId);
      const tabSet = s.tabSetByScope[scopeKey] ?? null;
      if (!tabSet) return s;
      const tabs = tabSet.tabs.map((tab) => {
        if (tab.id !== tabId) return tab;
        const next = {
          ...tab,
          title: chrome.title === undefined ? tab.title : chrome.title,
          url: chrome.url === undefined ? tab.url : chrome.url,
          faviconUrl: chrome.favicon === undefined ? tab.faviconUrl : chrome.favicon,
        };
        changed =
          next.title !== tab.title ||
          next.url !== tab.url ||
          next.faviconUrl !== tab.faviconUrl;
        if (changed) {
          persistedChrome = {
            title: next.title,
            url: next.url,
            faviconUrl: next.faviconUrl,
          };
        }
        return changed ? next : tab;
      });
      if (!changed) return s;
      return {
        tabSetByScope: {
          ...s.tabSetByScope,
          [scopeKey]: { ...tabSet, tabs },
        },
      };
    });
    if (!changed || !persistedChrome) return;
    void bridgeTabs()?.updateChrome?.(scopeId, workspaceId, tabId, persistedChrome).catch(() => undefined);
  },

  openPage: async (workspaceId, scopeId, options) => {
    const tabs = bridgeTabs();
    if (!tabs) return null;
      const r = await tabs.open(scopeId, workspaceId, {
        activate: options?.activate ?? true,
      ...(options?.tabId ? { tabId: options.tabId } : {}),
      ...(options?.initialAddress ? { initialAddress: options.initialAddress } : {}),
    });
      if (!r.ok) return null;
      get().setTabSet(workspaceId, scopeId, r.data.tabs);
      useBrowserAutomationStore.getState().refreshTarget(workspaceId, scopeId, r.data.tabId);
      // A user-created page is empty; drop the cursor into the URL field so the
      // user can type immediately (matches the panel-open shortcut's UX).
      if (shouldFocusOpenedPage(options)) usePreviewFocusStore.getState().requestOmniboxFocus();
      return r.data.tabId;
  },

  activatePage: async (workspaceId, scopeId, tabId) => {
    const tabs = bridgeTabs();
    if (!tabs) {
      const scopeKey = previewTabsScopeKey(workspaceId, scopeId);
      if (!get().persistentTabIdsByScope[scopeKey]?.has(tabId)) return;
      get().setLiveChrome(workspaceId, scopeId, null);
      set((s) => {
        const tabSet = s.tabSetByScope[scopeKey];
        if (!tabSet || !tabSet.tabs.some((tab) => tab.id === tabId)) return s;
        return {
          tabSetByScope: {
            ...s.tabSetByScope,
            [scopeKey]: {
              ...tabSet,
              activeTabId: tabId,
              tabs: tabSet.tabs.map((tab) => ({ ...tab, active: tab.id === tabId })),
            },
          },
        };
      });
      useBrowserAutomationStore.getState().refreshTarget(workspaceId, scopeId, tabId);
      return;
    }
    // The newly-active page has not emitted its live chrome yet; clear the
    // stale overlay so it does not paint the prior page's favicon onto it.
    get().setLiveChrome(workspaceId, scopeId, null);
    const r = await tabs.activate(scopeId, workspaceId, tabId);
    if (r.ok) {
      get().setTabSet(workspaceId, scopeId, r.data);
      useBrowserAutomationStore.getState().refreshTarget(workspaceId, scopeId, tabId);
    }
  },

  closePage: async (workspaceId, scopeId, tabId, opts) => {
    const tabs = bridgeTabs();
    if (!tabs) return closePersistentPage(workspaceId, scopeId, tabId, opts);
    return closeDesktopPage(tabs, workspaceId, scopeId, tabId, opts);
  },

  clearScope: async (workspaceId, scopeId) => {
    const tabs = bridgeTabs();
    const r = await tabs?.closeScope?.(scopeId, workspaceId);
    if (r && !r.ok) throw new Error(r.error);
    useBrowserAutomationStore.getState().releaseThreadTargets(workspaceId, scopeId);
    set((s) => clearPreviewScopeState(s, previewTabsScopeKey(workspaceId, scopeId), false));
  },
  };
});

/**
 * The display tab set for a scope: the host-truth set overlaid with the active
 * page's live chrome. Returns null when the scope has no known set (no browser
 * opened yet, or a non-desktop build). Pass null/undefined for a missing scope.
 */
export function usePreviewDisplayTabSet(
  scopeId: string | null | undefined,
  workspaceId?: string | null,
): BrowserTabSet | null {
  const exactWorkspaceId = workspaceId ?? scopeId;
  const scopeKey = scopeId && exactWorkspaceId ? previewTabsScopeKey(exactWorkspaceId, scopeId) : null;
  const tabSet = usePreviewTabsStore((s) => (scopeKey ? s.tabSetByScope[scopeKey] ?? null : null));
  const live = usePreviewTabsStore((s) => (scopeKey ? s.liveChromeByScope[scopeKey] ?? null : null));
  // overlayDisplaySet allocates a fresh set when live chrome is present; memoize
  // on the source references so an unchanged tick yields a stable reference and
  // does not defeat downstream memoization of the rail.
  return useMemo(() => overlayDisplaySet(tabSet, live), [tabSet, live]);
}
