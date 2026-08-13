import { describe, expect, it, vi } from "vitest";
import {
  createElectronWebviewBrowserSurfaceAdapterFactory,
  ElectronWebviewBrowserSurfaceAdapter,
} from "../ElectronWebviewBrowserSurfaceAdapter";
import type {
  BrowserSurfaceIdentity,
  BrowserSurfaceAdapterEvent,
} from "../BrowserSurfaceHost";
import type { PreviewSurfaceBridge } from "@/transport/desktop-bridge";
import { runBrowserSurfaceContract } from "./browserSurfaceContract";

const IDENTITY: BrowserSurfaceIdentity = {
  workspaceId: "workspace-electron",
  scope: { kind: "thread", id: "thread-electron" },
  tabId: "tab-electron",
};

function bridge(): PreviewSurfaceBridge & {
  prepare: ReturnType<typeof vi.fn>;
  adopt: ReturnType<typeof vi.fn>;
  navigate: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
} {
  return {
    prepare: vi.fn().mockResolvedValue({ ok: true }),
    adopt: vi.fn().mockResolvedValue({ ok: true }),
    navigate: vi.fn().mockResolvedValue({ ok: true }),
    release: vi.fn().mockResolvedValue({ ok: true }),
    onPopupRequested: vi.fn(() => () => undefined),
    onDiscardRequested: vi.fn(() => () => undefined),
  };
}

runBrowserSurfaceContract(
  "Electron webview BrowserSurfaceHost contract",
  createElectronWebviewBrowserSurfaceAdapterFactory({ root: document.body, bridge: bridge() }),
);

describe("ElectronWebviewBrowserSurfaceAdapter", () => {
  it("starts inert, adopts with an opaque complete identity, and navigates through the typed bridge", async () => {
    const surfaceBridge = bridge();
    const adapter = new ElectronWebviewBrowserSurfaceAdapter(IDENTITY, 7, {
      root: document.body,
      bridge: surfaceBridge,
    });
    const element = adapter.element;
    const inertSource = element.getAttribute("src");

    expect(element.tagName).toBe("WEBVIEW");
    expect(element.getAttribute("src")).toMatch(/^about:blank#[A-Za-z0-9_-]+$/);
    expect(element.hasAttribute("allowpopups")).toBe(true);
    expect(surfaceBridge.prepare).toHaveBeenCalledWith(expect.objectContaining({
      surface: { identity: IDENTITY, generation: 7 },
      adoptionToken: expect.any(String),
    }));
    expect(surfaceBridge.prepare.mock.calls[0]?.[0]).not.toHaveProperty("webContentsId");

    const pending = adapter.navigate("https://example.test/next");
    expect(surfaceBridge.navigate).not.toHaveBeenCalled();
    element.dispatchEvent(new Event("did-attach"));
    await pending;
    await vi.waitFor(() => expect(surfaceBridge.adopt).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(surfaceBridge.navigate).toHaveBeenCalledTimes(1));
    expect(surfaceBridge.adopt).toHaveBeenCalledWith(expect.objectContaining({
      surface: { identity: IDENTITY, generation: 7 },
      adoptionToken: surfaceBridge.prepare.mock.calls[0]?.[0].adoptionToken,
    }));
    expect(surfaceBridge.navigate).toHaveBeenCalledWith({
      surface: { identity: IDENTITY, generation: 7 },
      navigation: { kind: "address", address: "https://example.test/next" },
    });
    expect(surfaceBridge.navigate.mock.calls[0]?.[0]).not.toHaveProperty("webContentsId");
    expect(element.getAttribute("src")).toBe(inertSource);
    adapter.dispose();
  });

  it("emits generation-bound semantic events and owns presentation and disposal", () => {
    const surfaceBridge = bridge();
    const adapter = new ElectronWebviewBrowserSurfaceAdapter(IDENTITY, 3, {
      root: document.body,
      bridge: surfaceBridge,
    });
    const events: BrowserSurfaceAdapterEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    Object.assign(adapter.element, {
      canGoBack: vi.fn(() => true),
      canGoForward: vi.fn(() => false),
    });
    adapter.present({ left: 10, top: 20, width: 640, height: 480, scale: 1.25, zIndex: 42, coveredLeft: 112 });
    expect(adapter.element.style.left).toBe("10px");
    expect(adapter.element.style.width).toBe("640px");
    expect(adapter.element.style.zIndex).toBe("42");
    expect(adapter.element.style.clipPath).toBe("inset(0px 0px 0px 112px)");
    adapter.present({ left: 10, top: 20, width: 640, height: 480, coveredLeft: 0 });
    expect(adapter.element.style.clipPath).toBe("");
    adapter.hide();
    expect(adapter.element.style.visibility).toBe("hidden");

    adapter.element.dispatchEvent(Object.assign(new Event("did-start-loading"), {
      url: "https://example.test/loading",
      isMainFrame: true,
    }));
    adapter.element.dispatchEvent(Object.assign(new Event("did-navigate"), {
      url: "https://example.test/loaded",
      isMainFrame: true,
    }));
    adapter.element.dispatchEvent(Object.assign(new Event("page-title-updated"), { title: "Example" }));
    adapter.element.dispatchEvent(Object.assign(new Event("page-favicon-updated"), { favicons: ["https://example.test/icon.png"] }));
    adapter.element.dispatchEvent(new Event("render-process-gone"));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "load-started", identity: IDENTITY, generation: 3 }),
      expect.objectContaining({ type: "navigation-committed", address: "https://example.test/loaded", identity: IDENTITY, generation: 3 }),
      expect.objectContaining({ type: "title-updated", title: "Example", identity: IDENTITY, generation: 3 }),
      expect.objectContaining({ type: "favicon-updated", favicon: "https://example.test/icon.png", identity: IDENTITY, generation: 3 }),
      expect.objectContaining({ type: "surface-lost", identity: IDENTITY, generation: 3 }),
    ]));
    adapter.dispose();
    expect(surfaceBridge.release).toHaveBeenCalledWith({
      surface: { identity: IDENTITY, generation: 3 },
      reason: "dispose",
    });
    expect(document.body.contains(adapter.element)).toBe(false);
    expect(() => adapter.element.dispatchEvent(new Event("did-navigate"))).not.toThrow();
  });

  it("publishes renderer history state after address, history, and in-page commits", () => {
    const adapter = new ElectronWebviewBrowserSurfaceAdapter(IDENTITY, 4, {
      root: document.body,
      bridge: bridge(),
    });
    let canGoBack = false;
    let canGoForward = false;
    Object.assign(adapter.element, {
      canGoBack: vi.fn(() => canGoBack),
      canGoForward: vi.fn(() => canGoForward),
    });
    const navigationStates: Array<{ canGoBack: boolean; canGoForward: boolean } | null> = [];
    adapter.subscribe((event) => {
      if (event.type === "navigation-state") navigationStates.push(event.navigation);
    });

    const commit = (
      type: "did-navigate" | "did-navigate-in-page",
      address: string,
      state: { canGoBack: boolean; canGoForward: boolean },
    ): void => {
      canGoBack = state.canGoBack;
      canGoForward = state.canGoForward;
      adapter.element.dispatchEvent(Object.assign(new Event(type), { url: address, isMainFrame: true }));
    };

    commit("did-navigate", "https://example.test/one", { canGoBack: false, canGoForward: false });
    commit("did-navigate", "https://example.test/two", { canGoBack: true, canGoForward: false });
    commit("did-navigate", "https://example.test/one", { canGoBack: false, canGoForward: true });
    commit("did-navigate", "https://example.test/two", { canGoBack: true, canGoForward: false });
    commit("did-navigate-in-page", "https://example.test/two#section", { canGoBack: true, canGoForward: false });
    adapter.element.dispatchEvent(new Event("dom-ready"));

    expect(navigationStates).toEqual([
      { canGoBack: false, canGoForward: false },
      { canGoBack: true, canGoForward: false },
      { canGoBack: false, canGoForward: true },
      { canGoBack: true, canGoForward: false },
      { canGoBack: true, canGoForward: false },
      { canGoBack: true, canGoForward: false },
    ]);
    adapter.dispose();
  });

  it("retries the bounded guest discovery race after did-attach", async () => {
    const surfaceBridge = bridge();
    surfaceBridge.adopt
      .mockResolvedValueOnce({ ok: false, error: "guest-not-found" })
      .mockResolvedValueOnce({ ok: true });
    const adapter = new ElectronWebviewBrowserSurfaceAdapter(IDENTITY, 5, {
      root: document.body,
      bridge: surfaceBridge,
    });

    adapter.element.dispatchEvent(new Event("did-attach"));

    await vi.waitFor(() => expect(surfaceBridge.adopt).toHaveBeenCalledTimes(2));
    adapter.dispose();
  });

  it("reports the next valid generation when preparation finds stale renderer state", async () => {
    const surfaceBridge = bridge();
    surfaceBridge.prepare.mockResolvedValue({
      ok: false,
      error: "stale-generation",
      nextGeneration: 12,
    });
    const adapter = new ElectronWebviewBrowserSurfaceAdapter(IDENTITY, 1, {
      root: document.body,
      bridge: surfaceBridge,
    });
    const events: BrowserSurfaceAdapterEvent[] = [];
    adapter.subscribe((event) => events.push(event));

    adapter.create();

    await vi.waitFor(() => expect(events).toContainEqual({
      type: "surface-lost",
      identity: IDENTITY,
      generation: 1,
      nextGeneration: 12,
    }));
    adapter.dispose();
  });
});
