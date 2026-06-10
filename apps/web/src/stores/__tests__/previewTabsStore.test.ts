import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type { BrowserTabInfo, BrowserTabSet } from "@mcode/contracts";
import {
  overlayDisplaySet,
  usePreviewTabsStore,
  type PreviewLiveChrome,
} from "../previewTabsStore";
import { usePreviewFocusStore } from "../previewFocusStore";

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).desktopBridge = {
    preview: { tabs: { create, activate, close, list: vi.fn(), onUpdated: vi.fn() } },
  };
  return { create, activate, close };
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
    usePreviewTabsStore.setState({ tabSetByScope: {}, liveChromeByScope: {} });
    usePreviewFocusStore.setState({ omniboxFocusTick: 0 });
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

  it("closePage fires onLastClose when closing the last page", async () => {
    usePreviewTabsStore.getState().setTabSet(SCOPE, set("a", [page("a")]));
    mockBridge({});
    const onLastClose = vi.fn();
    await usePreviewTabsStore.getState().closePage(SCOPE, "a", { onLastClose });
    expect(onLastClose).toHaveBeenCalledTimes(1);
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
});
