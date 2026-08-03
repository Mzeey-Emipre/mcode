import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type { BrowserTabInfo, BrowserTabSet } from "@mcode/contracts";
import {
  overlayDisplaySet,
  usePreviewTabsStore,
  type PreviewLiveChrome,
} from "../previewTabsStore";
import { usePreviewFocusStore } from "../previewFocusStore";
import { useBrowserAutomationStore } from "../browserAutomationStore";
import { browserTargetRegistry } from "@/services/browser-automation/browserTargetRegistry";

const SCOPE = "thread-1";

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
  create?: BrowserTabSet;
  activate?: BrowserTabSet;
  close?: BrowserTabSet;
  closeScope?: BrowserTabSet;
}) {
  const create = vi.fn(async () => ({
    ok: true as const,
    data: { tabId: "new", tabs: handlers.create ?? set("new", [page("new")]) },
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).desktopBridge = {
    preview: { tabs: { create, activate, close, closeScope, list: vi.fn(), onUpdated: vi.fn() } },
  };
  return { create, activate, close, closeScope };
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
    setTabSet(SCOPE, ts);
    setLiveChrome(SCOPE, { title: "T", url: null, favicon: null });
    expect(usePreviewTabsStore.getState().tabSetByScope[SCOPE]).toBe(ts);
    expect(usePreviewTabsStore.getState().liveChromeByScope[SCOPE]?.title).toBe("T");
  });

  it("createPage adds a page via the bridge and focuses the omnibox", async () => {
    const created = set("new", [page("a"), page("new", { active: true })]);
    const { create } = mockBridge({ create: created });
    await usePreviewTabsStore.getState().createPage(SCOPE);
    expect(create).toHaveBeenCalledWith(SCOPE, true);
    expect(usePreviewTabsStore.getState().tabSetByScope[SCOPE]).toBe(created);
    expect(usePreviewFocusStore.getState().omniboxFocusTick).toBe(1);
  });

  it("activatePage switches the active page and clears stale live chrome", async () => {
    usePreviewTabsStore.getState().setLiveChrome(SCOPE, { title: "stale", url: null, favicon: null });
    const switched = set("b", [page("a"), page("b", { active: true })]);
    const { activate } = mockBridge({ activate: switched });
    await usePreviewTabsStore.getState().activatePage(SCOPE, "b");
    expect(activate).toHaveBeenCalledWith(SCOPE, "b");
    expect(usePreviewTabsStore.getState().tabSetByScope[SCOPE]).toBe(switched);
    expect(usePreviewTabsStore.getState().liveChromeByScope[SCOPE]).toBeNull();
  });

  it("closePage closes a non-last page without firing onLastClose", async () => {
    usePreviewTabsStore.getState().setTabSet(SCOPE, set("a", [page("a"), page("b")]));
    const remaining = set("a", [page("a")]);
    const { close } = mockBridge({ close: remaining });
    const onLastClose = vi.fn();
    await usePreviewTabsStore.getState().closePage(SCOPE, "b", { onLastClose });
    expect(close).toHaveBeenCalledWith(SCOPE, "b");
    expect(onLastClose).not.toHaveBeenCalled();
    expect(usePreviewTabsStore.getState().tabSetByScope[SCOPE]).toBe(remaining);
  });

  it("closePage fires onLastClose and drops the scope's set when closing the last page", async () => {
    usePreviewTabsStore.getState().setTabSet(SCOPE, set("a", [page("a")]));
    mockBridge({});
    const onLastClose = vi.fn();
    await usePreviewTabsStore.getState().closePage(SCOPE, "a", { onLastClose });
    expect(onLastClose).toHaveBeenCalledTimes(1);
    // The host recreates a blank fallback, but the Browser tab is gone; the
    // scope's set must clear rather than retain a phantom page.
    expect(usePreviewTabsStore.getState().tabSetByScope[SCOPE]).toBeNull();
  });

  it("clearScope releases every target after a successful scope close", async () => {
    useBrowserAutomationStore.getState().registerTarget("workspace-1", SCOPE, "a");
    useBrowserAutomationStore.getState().registerTarget("workspace-1", SCOPE, "b");
    useBrowserAutomationStore.getState().registerTarget("workspace-1", "thread-2", "other");
    const { closeScope } = mockBridge({});

    await usePreviewTabsStore.getState().clearScope(SCOPE);

    expect(closeScope).toHaveBeenCalledWith(SCOPE);
    expect(browserTargetRegistry.get(SCOPE, "a")).toBeNull();
    expect(browserTargetRegistry.get(SCOPE, "b")).toBeNull();
    expect(browserTargetRegistry.get("thread-2", "other")).not.toBeNull();
  });

  it("clearScope retains targets when the physical scope close fails", async () => {
    useBrowserAutomationStore.getState().registerTarget("workspace-1", SCOPE, "a");
    const { closeScope } = mockBridge({});
    closeScope.mockResolvedValueOnce({ ok: false, error: "scope close failed" });

    await expect(usePreviewTabsStore.getState().clearScope(SCOPE)).rejects.toThrow("scope close failed");
    expect(browserTargetRegistry.get(SCOPE, "a")).not.toBeNull();
  });

  it("setLiveChrome keeps the same reference when the chrome is unchanged", () => {
    const { setLiveChrome } = usePreviewTabsStore.getState();
    setLiveChrome(SCOPE, { title: "T", url: "u", favicon: "f" });
    const first = usePreviewTabsStore.getState().liveChromeByScope;
    setLiveChrome(SCOPE, { title: "T", url: "u", favicon: "f" });
    // An identical tick must not notify subscribers (re-render storm guard).
    expect(usePreviewTabsStore.getState().liveChromeByScope).toBe(first);
    setLiveChrome(SCOPE, { title: "Changed", url: "u", favicon: "f" });
    expect(usePreviewTabsStore.getState().liveChromeByScope).not.toBe(first);
  });

  it("updateTabChrome persists renderer-observed favicon for inactive tabs", () => {
    const { setTabSet, updateTabChrome } = usePreviewTabsStore.getState();
    setTabSet(
      SCOPE,
      set("a", [
        page("a", { title: "A", faviconUrl: "https://a.test/favicon.ico" }),
        page("b", { title: "B", url: "https://b.test" }),
      ]),
    );

    updateTabChrome(SCOPE, "b", {
      title: "B updated",
      url: "https://b.test/path",
      favicon: "https://b.test/favicon.ico",
    });

    const tabSet = usePreviewTabsStore.getState().tabSetByScope[SCOPE]!;
    expect(tabSet.tabs[0]!.faviconUrl).toBe("https://a.test/favicon.ico");
    expect(tabSet.tabs[1]).toMatchObject({
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
    setTabSet(SCOPE, tabSet);

    updateTabChrome(SCOPE, "a", {
      title: "A",
      url: "https://a.test",
      favicon: "https://a.test/favicon.ico",
    });

    expect(usePreviewTabsStore.getState().tabSetByScope[SCOPE]).toBe(tabSet);
  });

  it("page actions are no-ops without a desktop bridge", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).desktopBridge = undefined;
    const onLastClose = vi.fn();
    await usePreviewTabsStore.getState().createPage(SCOPE);
    await usePreviewTabsStore.getState().activatePage(SCOPE, "a");
    await usePreviewTabsStore.getState().closePage(SCOPE, "a", { onLastClose });
    expect(onLastClose).not.toHaveBeenCalled();
    expect(usePreviewTabsStore.getState().tabSetByScope[SCOPE]).toBeUndefined();
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
    usePreviewTabsStore.getState().upsertPersistentTab(SCOPE, persistent);
    usePreviewTabsStore.getState().upsertPersistentTab(SCOPE, second);

    await usePreviewTabsStore.getState().activatePage(SCOPE, persistent.id);
    expect(usePreviewTabsStore.getState().tabSetByScope[SCOPE]?.activeTabId).toBe(persistent.id);
    expect(usePreviewTabsStore.getState().tabSetByScope[SCOPE]?.tabs[0]?.active).toBe(true);

    const onLastClose = vi.fn();
    await usePreviewTabsStore.getState().closePage(SCOPE, second.id, { onLastClose });
    expect(onLastClose).not.toHaveBeenCalled();
    expect(usePreviewTabsStore.getState().tabSetByScope[SCOPE]).toMatchObject({
      activeTabId: persistent.id,
      tabs: [{ ...persistent, active: true }],
    });

    await usePreviewTabsStore.getState().closePage(SCOPE, persistent.id, { onLastClose });
    expect(onLastClose).toHaveBeenCalledOnce();
    expect(usePreviewTabsStore.getState().tabSetByScope[SCOPE]).toBeNull();
    expect(usePreviewTabsStore.getState().persistentTabIdsByScope[SCOPE]).toBeUndefined();
  });
});
