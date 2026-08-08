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
    adapter.present({ left: 10, top: 20, width: 640, height: 480, scale: 1.25, zIndex: 42 });
    expect(adapter.element.style.left).toBe("10px");
    expect(adapter.element.style.width).toBe("640px");
    expect(adapter.element.style.zIndex).toBe("42");
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
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "load-started", identity: IDENTITY, generation: 3 }),
      expect.objectContaining({ type: "navigation-committed", address: "https://example.test/loaded", identity: IDENTITY, generation: 3 }),
      expect.objectContaining({ type: "title-updated", title: "Example", identity: IDENTITY, generation: 3 }),
      expect.objectContaining({ type: "favicon-updated", favicon: "https://example.test/icon.png", identity: IDENTITY, generation: 3 }),
    ]));
    adapter.dispose();
    expect(surfaceBridge.release).toHaveBeenCalledWith({ surface: { identity: IDENTITY, generation: 3 } });
    expect(document.body.contains(adapter.element)).toBe(false);
    expect(() => adapter.element.dispatchEvent(new Event("did-navigate"))).not.toThrow();
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
});
