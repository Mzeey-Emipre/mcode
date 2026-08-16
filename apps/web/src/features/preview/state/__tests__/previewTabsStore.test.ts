import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type { BrowserTabInfo, BrowserTabSet } from "@mcode/contracts";
import {
  overlayDisplaySet,
  previewTabsScopeKey,
  usePreviewTabsStore,
  type PreviewLiveChrome,
} from "../previewTabsStore";
import { usePreviewFocusStore } from "../previewFocusStore";
import { useBrowserAutomationStore } from "../../automation/browserAutomationStore";
import { browserTargetRegistry } from "../../automation/services/browserTargetRegistry";

const SCOPE = "thread-1";
const WORKSPACE_ID = "workspace-1";
const SCOPE_KEY = previewTabsScopeKey(WORKSPACE_ID, SCOPE);

function page(id: string, over: Partial<BrowserTabInfo> = {}): BrowserTabInfo {
  return {
    id,
    threadId: SCOPE,
    title: null,
    url: null,
    faviconUrl: null,
    warm: true,
    active: false,
    ...over,
  };
}

function set(activeTabId: string | null, tabs: BrowserTabInfo[]): BrowserTabSet {
  return { threadId: SCOPE, activeTabId, tabs };
}

/** A controllable mock of `desktopBridge.preview.tabs` returning shaped results. */
function mockBridge(handlers: {
  open?: BrowserTabSet;
  activate?: BrowserTabSet;
  close?: BrowserTabSet;
  closeScope?: BrowserTabSet;
}) {
  const open = vi.fn(async () => ({
    ok: true as const,
    data: { tabId: "new", tabs: handlers.open ?? set("new", [page("new")]) },
  }));
  const activate = vi.fn(async () => ({
    ok: true as const,
    data: handlers.activate ?? set("b", [page("a"), page("b")]),
  }));
  const close = vi.fn(async () => ({
    ok: true as const,
    data: handlers.close ?? set("a", [page("a")]),
  }));
  const closeScope = vi.fn(async (): Promise<
    { ok: true; data: BrowserTabSet } | { ok: false; error: string }
  > => ({
    ok: true as const,
    data: handlers.closeScope ?? set(null, []),
  }));
  const updateChrome = vi.fn(async () => ({
    ok: true as const,
    data: set("a", [page("a")]),
  }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).desktopBridge = {
    preview: { tabs: { open, activate, updateChrome, close, closeScope, list: vi.fn(), onUpdated: vi.fn() } },
  };
  return { open, activate, updateChrome, close, closeScope };
}

describe("overlayDisplaySet", () => {
  it("returns the tab set unchanged when there is no live chrome", () => {
    const ts = set("a", [page("a", { title: "A" })]);
    expect(overlayDisplaySet(ts, null)).toBe(ts);
  });

  it("returns null when the tab set is null", () => {
    expect(overlayDisplaySet(null, { title: "x", url: null, favicon: null })).toBeNull();
  });

  it("overlays live chrome onto the active tab only", () => {
    const ts = set("a", [page("a", { title: "old" }), page("b", { title: "B" })]);
    const live: PreviewLiveChrome = {
      title: "Live",
      url: "https://live.test",
      favicon: "https://live.test/favicon.ico",
    };
    const out = overlayDisplaySet(ts, live)!;
    expect(out.tabs[0]).toMatchObject({
      title: "Live",
      url: "https://live.test",
      faviconUrl: "https://live.test/favicon.ico",
    });
    // The inactive tab is untouched.
    expect(out.tabs[1].title).toBe("B");
  });

  it("falls back to the tab's own chrome when a live field is null", () => {
    const ts = set("a", [page("a", { title: "Real", url: "https://real.test" })]);
    const live: PreviewLiveChrome = { title: null, url: null, favicon: null };
    const out = overlayDisplaySet(ts, live)!;
    expect(out.tabs[0].title).toBe("Real");
    expect(out.tabs[0].url).toBe("https://real.test");
  });
});

describe("previewTabsStore", () => {
  beforeEach(() => {
    usePreviewTabsStore.setState({ tabSetByScope: {}, liveChromeByScope: {}, persistentTabIdsByScope: {} });
    usePreviewFocusStore.setState({ omniboxFocusTick: 0 });
    browserTargetRegistry.clear();
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).desktopBridge = undefined;
    vi.restoreAllMocks();
  });

  it("setTabSet / setLiveChrome reconcile per scope", () => {
    const { setTabSet, setLiveChrome } = usePreviewTabsStore.getState();
    const ts = set("a", [page("a")]);
    setTabSet(WORKSPACE_ID, SCOPE, ts);
    setLiveChrome(WORKSPACE_ID, SCOPE, { title: "T", url: null, favicon: null });
    expect(usePreviewTabsStore.getState().tabSetByScope[SCOPE_KEY]).toBe(ts);
    expect(usePreviewTabsStore.getState().liveChromeByScope[SCOPE_KEY]?.title).toBe("T");
  });

  it("setTabSet preserves state identity for a semantically identical host snapshot", () => {
    const { setTabSet } = usePreviewTabsStore.getState();
    setTabSet(WORKSPACE_ID, SCOPE, set("a", [page("a")]));
    const previousState = usePreviewTabsStore.getState();
    const subscriber = vi.fn();
    const unsubscribe = usePreviewTabsStore.subscribe(subscriber);

    setTabSet(WORKSPACE_ID, SCOPE, set("a", [page("a")]));

    expect(usePreviewTabsStore.getState()).toBe(previousState);
    expect(subscriber).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("clears live chrome when the host activates another page", () => {
    const { setTabSet, setLiveChrome } = usePreviewTabsStore.getState();
    setTabSet(WORKSPACE_ID, SCOPE, set("first", [
      page("first", { url: "https://example.com/?first", active: true }),
      page("second", { url: "https://example.org/?second" }),
    ]));
    setLiveChrome(WORKSPACE_ID, SCOPE, {
      title: "First",
      url: "https://example.com/?first",
      favicon: null,
    });

    setTabSet(WORKSPACE_ID, SCOPE, set("second", [
      page("first", { url: "https://example.com/?first" }),
      page("second", { url: "https://example.org/?second", active: true }),
    ]));

    const state = usePreviewTabsStore.getState();
    const display = overlayDisplaySet(
      state.tabSetByScope[SCOPE_KEY] ?? null,
      state.liveChromeByScope[SCOPE_KEY] ?? null,
    );
    expect(display?.tabs.find((tab) => tab.id === "second")?.url).toBe("https://example.org/?second");
  });

  it("keeps equal scope ids isolated by workspace", () => {
    const otherWorkspaceId = "workspace-2";
    const firstKey = previewTabsScopeKey(WORKSPACE_ID, SCOPE);
    const secondKey = previewTabsScopeKey(otherWorkspaceId, SCOPE);
    const firstSet = set("first", [page("first")]);
    const secondSet = set("second", [page("second")]);

    usePreviewTabsStore.getState().setTabSet(WORKSPACE_ID, SCOPE, firstSet);
    usePreviewTabsStore.getState().setTabSet(otherWorkspaceId, SCOPE, secondSet);
    usePreviewTabsStore.getState().setLiveChrome(WORKSPACE_ID, SCOPE, {
      title: "First",
      url: "https://first.test",
      favicon: null,
    });
    usePreviewTabsStore.getState().setLiveChrome(otherWorkspaceId, SCOPE, {
      title: "Second",
      url: "https://second.test",
      favicon: null,
    });
    usePreviewTabsStore.getState().upsertPersistentTab(WORKSPACE_ID, SCOPE, page("persistent"));
    usePreviewTabsStore.getState().upsertPersistentTab(otherWorkspaceId, SCOPE, page("persistent"));

    const state = usePreviewTabsStore.getState();
    expect(state.tabSetByScope[firstKey]?.tabs.map((tab) => tab.id)).toEqual(["first", "persistent"]);
    expect(state.tabSetByScope[secondKey]?.tabs.map((tab) => tab.id)).toEqual(["second", "persistent"]);
    expect(state.liveChromeByScope[firstKey]?.title).toBe("First");
    expect(state.liveChromeByScope[secondKey]?.title).toBe("Second");
    expect(state.persistentTabIdsByScope[firstKey]).toEqual(new Set(["persistent"]));
    expect(state.persistentTabIdsByScope[secondKey]).toEqual(new Set(["persistent"]));
  });

  it("openPage creates a page via the bridge and focuses the omnibox", async () => {
    const created = set("new", [page("a"), page("new", { active: true })]);
    const { open } = mockBridge({ open: created });
    await usePreviewTabsStore.getState().openPage(WORKSPACE_ID, SCOPE);
    expect(open).toHaveBeenCalledWith(SCOPE, WORKSPACE_ID, { activate: true });
    expect(usePreviewTabsStore.getState().tabSetByScope[SCOPE_KEY]).toBe(created);
    expect(usePreviewFocusStore.getState().omniboxFocusTick).toBe(1);
  });

  it("openPage passes an exact existing page id to the bridge", async () => {
    const { open } = mockBridge({});

    await usePreviewTabsStore.getState().openPage(WORKSPACE_ID, SCOPE, {
      activate: false,
      focusOmnibox: false,
      tabId: "blank",
    });

    expect(open).toHaveBeenCalledWith(SCOPE, WORKSPACE_ID, {
      activate: false,
      tabId: "blank",
    });
  });

  it("openPage passes a bounded initial address to the bridge", async () => {
    const { open } = mockBridge({});

    await usePreviewTabsStore.getState().openPage(WORKSPACE_ID, SCOPE, {
      activate: true,
      focusOmnibox: false,
      initialAddress: "https://popup.example.test/next",
    });

    expect(open).toHaveBeenCalledWith(SCOPE, WORKSPACE_ID, {
      activate: true,
      initialAddress: "https://popup.example.test/next",
    });
  });

  it("activatePage switches the active page and clears stale live chrome", async () => {
    usePreviewTabsStore.getState().setLiveChrome(WORKSPACE_ID, SCOPE, { title: "stale", url: null, favicon: null });
    const switched = set("b", [page("a"), page("b", { active: true })]);
    const { activate } = mockBridge({ activate: switched });
    await usePreviewTabsStore.getState().activatePage(WORKSPACE_ID, SCOPE, "b");
    expect(activate).toHaveBeenCalledWith(SCOPE, WORKSPACE_ID, "b");
    expect(usePreviewTabsStore.getState().tabSetByScope[SCOPE_KEY]).toBe(switched);
    expect(usePreviewTabsStore.getState().liveChromeByScope[SCOPE_KEY]).toBeNull();
  });

  it("closePage closes a non-last page without firing onLastClose", async () => {
    usePreviewTabsStore.getState().setTabSet(WORKSPACE_ID, SCOPE, set("a", [page("a"), page("b")]));
    const remaining = set("a", [page("a")]);
    const { close } = mockBridge({ close: remaining });
    const onLastClose = vi.fn();
    await usePreviewTabsStore.getState().closePage(WORKSPACE_ID, SCOPE, "b", { onLastClose });
    expect(close).toHaveBeenCalledWith(SCOPE, WORKSPACE_ID, "b");
    expect(onLastClose).not.toHaveBeenCalled();
    expect(usePreviewTabsStore.getState().tabSetByScope[SCOPE_KEY]).toBe(remaining);
  });

  it("closePage fires onLastClose and drops the scope's set when closing the last page", async () => {
    usePreviewTabsStore.getState().setTabSet(WORKSPACE_ID, SCOPE, set("a", [page("a")]));
    const { close, closeScope } = mockBridge({});
    usePreviewTabsStore.getState().setLiveChrome(WORKSPACE_ID, SCOPE, { title: "A", url: null, favicon: null });
    useBrowserAutomationStore.getState().registerTarget(WORKSPACE_ID, SCOPE, "a");
    const onLastClose = vi.fn();
    onLastClose.mockImplementation(() => {
      expect(usePreviewTabsStore.getState().tabSetByScope[SCOPE_KEY]).toBeNull();
      expect(usePreviewTabsStore.getState().liveChromeByScope[SCOPE_KEY]).toBeNull();
    });
    await usePreviewTabsStore.getState().closePage(WORKSPACE_ID, SCOPE, "a", { onLastClose });
    expect(onLastClose).toHaveBeenCalledTimes(1);
    expect(closeScope).toHaveBeenCalledWith(SCOPE, WORKSPACE_ID);
    expect(close).not.toHaveBeenCalled();
    expect(browserTargetRegistry.get(WORKSPACE_ID, SCOPE, "a")).toBeNull();
    // The Browser tab is gone; the scope's set must clear rather than retain
    // a phantom page.
    expect(usePreviewTabsStore.getState().tabSetByScope[SCOPE_KEY]).toBeNull();
  });

  it("clearScope releases every target after a successful scope close", async () => {
    useBrowserAutomationStore.getState().registerTarget(WORKSPACE_ID, SCOPE, "a");
    useBrowserAutomationStore.getState().registerTarget(WORKSPACE_ID, SCOPE, "b");
    useBrowserAutomationStore.getState().registerTarget(WORKSPACE_ID, "thread-2", "other");
    const { closeScope } = mockBridge({});

    await usePreviewTabsStore.getState().clearScope(WORKSPACE_ID, SCOPE);

    expect(closeScope).toHaveBeenCalledWith(SCOPE, WORKSPACE_ID);
    expect(browserTargetRegistry.get(WORKSPACE_ID, SCOPE, "a")).toBeNull();
    expect(browserTargetRegistry.get(WORKSPACE_ID, SCOPE, "b")).toBeNull();
    expect(browserTargetRegistry.get(WORKSPACE_ID, "thread-2", "other")).not.toBeNull();
  });

  it("clearScope retains targets when the physical scope close fails", async () => {
    useBrowserAutomationStore.getState().registerTarget(WORKSPACE_ID, SCOPE, "a");
    const { closeScope } = mockBridge({});
    closeScope.mockResolvedValueOnce({ ok: false, error: "scope close failed" });

    await expect(usePreviewTabsStore.getState().clearScope(WORKSPACE_ID, SCOPE)).rejects.toThrow("scope close failed");
    expect(browserTargetRegistry.get(WORKSPACE_ID, SCOPE, "a")).not.toBeNull();
  });

  it("retains final-page UI state and automation targets when the physical scope close fails", async () => {
    const finalTabSet = set("a", [page("a")]);
    usePreviewTabsStore.getState().setTabSet(WORKSPACE_ID, SCOPE, finalTabSet);
    usePreviewTabsStore.getState().setLiveChrome(WORKSPACE_ID, SCOPE, { title: "A", url: "https://example.test", favicon: null });
    const { close, closeScope } = mockBridge({});
    closeScope.mockResolvedValueOnce({ ok: false, error: "scope close failed" });
    useBrowserAutomationStore.getState().registerTarget(WORKSPACE_ID, SCOPE, "a");
    const onLastClose = vi.fn();

    await usePreviewTabsStore.getState().closePage(WORKSPACE_ID, SCOPE, "a", { onLastClose });

    expect(close).not.toHaveBeenCalled();
    expect(onLastClose).not.toHaveBeenCalled();
    expect(browserTargetRegistry.get(WORKSPACE_ID, SCOPE, "a")).not.toBeNull();
    expect(usePreviewTabsStore.getState().tabSetByScope[SCOPE_KEY]).toBe(finalTabSet);
    expect(usePreviewTabsStore.getState().liveChromeByScope[SCOPE_KEY]).toEqual({
      title: "A",
      url: "https://example.test",
      favicon: null,
    });
  });

  it("setLiveChrome keeps the same reference when the chrome is unchanged", () => {
    const { setLiveChrome } = usePreviewTabsStore.getState();
    setLiveChrome(WORKSPACE_ID, SCOPE, { title: "T", url: "u", favicon: "f" });
    const first = usePreviewTabsStore.getState().liveChromeByScope;
    setLiveChrome(WORKSPACE_ID, SCOPE, { title: "T", url: "u", favicon: "f" });
    // An identical tick must not notify subscribers (re-render storm guard).
    expect(usePreviewTabsStore.getState().liveChromeByScope).toBe(first);
    setLiveChrome(WORKSPACE_ID, SCOPE, { title: "Changed", url: "u", favicon: "f" });
    expect(usePreviewTabsStore.getState().liveChromeByScope).not.toBe(first);
  });

  it("updateTabChrome persists renderer-observed favicon for inactive tabs", () => {
    const { updateChrome } = mockBridge({});
    const { setTabSet, updateTabChrome } = usePreviewTabsStore.getState();
    setTabSet(
      WORKSPACE_ID,
      SCOPE,
      set("a", [
        page("a", { title: "A", faviconUrl: "https://a.test/favicon.ico" }),
        page("b", { title: "B", url: "https://b.test" }),
      ]),
    );

    updateTabChrome(WORKSPACE_ID, SCOPE, "b", {
      title: "B updated",
      url: "https://b.test/path",
      favicon: "https://b.test/favicon.ico",
    });

    const tabSet = usePreviewTabsStore.getState().tabSetByScope[SCOPE_KEY]!;
    expect(tabSet.tabs[0]!.faviconUrl).toBe("https://a.test/favicon.ico");
    expect(tabSet.tabs[1]).toMatchObject({
      title: "B updated",
      url: "https://b.test/path",
      faviconUrl: "https://b.test/favicon.ico",
    });
    expect(updateChrome).toHaveBeenCalledWith(SCOPE, WORKSPACE_ID, "b", {
      title: "B updated",
      url: "https://b.test/path",
      faviconUrl: "https://b.test/favicon.ico",
    });
  });

  it("updateTabChrome keeps the same tab set reference when chrome is unchanged", () => {
    const { setTabSet, updateTabChrome } = usePreviewTabsStore.getState();
    const tabSet = set("a", [
      page("a", {
        title: "A",
        url: "https://a.test",
        faviconUrl: "https://a.test/favicon.ico",
      }),
    ]);
    setTabSet(WORKSPACE_ID, SCOPE, tabSet);

    updateTabChrome(WORKSPACE_ID, SCOPE, "a", {
      title: "A",
      url: "https://a.test",
      favicon: "https://a.test/favicon.ico",
    });

    expect(usePreviewTabsStore.getState().tabSetByScope[SCOPE_KEY]).toBe(tabSet);
  });

  it("updateTabChrome persists explicit null values that clear tab chrome", () => {
    const { updateChrome } = mockBridge({});
    const { setTabSet, updateTabChrome } = usePreviewTabsStore.getState();
    setTabSet(
      WORKSPACE_ID,
      SCOPE,
      set("a", [
        page("a", {
          title: "Loaded",
          url: "https://a.test",
          faviconUrl: "https://a.test/favicon.ico",
        }),
      ]),
    );

    updateTabChrome(WORKSPACE_ID, SCOPE, "a", {
      title: null,
      url: null,
      favicon: null,
    });

    expect(usePreviewTabsStore.getState().tabSetByScope[SCOPE_KEY]?.tabs[0]).toMatchObject({
      title: null,
      url: null,
      faviconUrl: null,
    });
    expect(updateChrome).toHaveBeenCalledWith(SCOPE, WORKSPACE_ID, "a", {
      title: null,
      url: null,
      faviconUrl: null,
    });
  });

  it("page actions are no-ops without a desktop bridge", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).desktopBridge = undefined;
    const onLastClose = vi.fn();
    await usePreviewTabsStore.getState().openPage(WORKSPACE_ID, SCOPE);
    await usePreviewTabsStore.getState().activatePage(WORKSPACE_ID, SCOPE, "a");
    await usePreviewTabsStore.getState().closePage(WORKSPACE_ID, SCOPE, "a", { onLastClose });
    expect(onLastClose).not.toHaveBeenCalled();
    expect(usePreviewTabsStore.getState().tabSetByScope[SCOPE_KEY]).toBeUndefined();
  });

  it("closes persistent web tabs with bridge-equivalent last-close behavior", async () => {
    const persistent = page("web-agent-1", {
      title: null,
      url: "https://example.test/start",
    });
    const second = page("web-agent-2", {
      title: null,
      url: "https://example.test/second",
    });
    usePreviewTabsStore.getState().upsertPersistentTab(WORKSPACE_ID, SCOPE, persistent);
    usePreviewTabsStore.getState().upsertPersistentTab(WORKSPACE_ID, SCOPE, second);

    await usePreviewTabsStore.getState().activatePage(WORKSPACE_ID, SCOPE, persistent.id);
    expect(usePreviewTabsStore.getState().tabSetByScope[SCOPE_KEY]?.activeTabId).toBe(persistent.id);
    expect(usePreviewTabsStore.getState().tabSetByScope[SCOPE_KEY]?.tabs[0]?.active).toBe(true);

    const onLastClose = vi.fn();
    await usePreviewTabsStore.getState().closePage(WORKSPACE_ID, SCOPE, second.id, { onLastClose });
    expect(onLastClose).not.toHaveBeenCalled();
    expect(usePreviewTabsStore.getState().tabSetByScope[SCOPE_KEY]).toMatchObject({
      activeTabId: persistent.id,
      tabs: [{ ...persistent, active: true }],
    });

    await usePreviewTabsStore.getState().closePage(WORKSPACE_ID, SCOPE, persistent.id, { onLastClose });
    expect(onLastClose).toHaveBeenCalledOnce();
    expect(usePreviewTabsStore.getState().tabSetByScope[SCOPE_KEY]).toBeNull();
    expect(usePreviewTabsStore.getState().persistentTabIdsByScope[SCOPE_KEY]).toBeUndefined();
  });
});
