import * as NodeEvents from "node:events";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSession,
  previewTabScopeKey,
  sessions,
  type PreviewSession,
} from "../../state/window-session.js";
import {
  _resetAdoptionRegistryForTests,
  registerPreviewSurfaceHandlers,
} from "../../surfaces/registry.js";
import { registerOverlayHandlers } from "../overlay.js";

interface FakeHostWebContents {
  isDestroyed: () => boolean;
  send: ReturnType<typeof vi.fn>;
}

interface FakeWindow {
  id: number;
  destroyed: boolean;
  isDestroyed: () => boolean;
  webContents: FakeHostWebContents;
}

const overlayTest = vi.hoisted(() => ({
  ipcHandlers: {} as Record<string, (...args: unknown[]) => unknown>,
  fakeGuests: [] as FakeGuest[],
  allWindows: [] as FakeWindow[],
  previewPartition: {},
  currentWindow: null as FakeWindow | null,
}));

class FakeGuest extends NodeEvents.EventEmitter {
  public readonly id: number;
  public destroyed = false;
  public url: string;
  public readonly hostWebContents: FakeHostWebContents;
  public readonly session = overlayTest.previewPartition;
  public readonly dom: JSDOM;
  public readonly executeJavaScript: ReturnType<typeof vi.fn>;
  public readonly capturePage: ReturnType<typeof vi.fn>;
  public readonly setWindowOpenHandler = vi.fn();
  public hitTestFailure = false;
  public injectionGate: Promise<void> | null = null;
  public injectionMode: "region" | "element" | null = null;
  public regionRemoveCount = 0;
  public elementRemoveCount = 0;

  public constructor(host: FakeWindow, adoptionToken: string) {
    super();
    this.id = overlayTest.fakeGuests.length + 100;
    this.hostWebContents = host.webContents;
    this.url = `about:blank#${adoptionToken}`;
    this.dom = new JSDOM(
      "<!doctype html><html><body><button id='target'>Target</button></body></html>",
      { runScripts: "outside-only" },
    );
    this.executeJavaScript = vi.fn(async (script: string) => {
      const isRegionInjection = script.includes("window.__mcodeRgState =");
      const isElementInjection = script.includes("window.__mcodeEpState =");
      if (
        this.injectionGate &&
        (this.injectionMode === "region" && isRegionInjection ||
          this.injectionMode === "element" && isElementInjection)
      ) {
        await this.injectionGate;
      }
      if (script.includes("typeof window.__mcodeRgTeardown")) this.regionRemoveCount += 1;
      if (script.includes("typeof window.__mcodeEpTeardown")) this.elementRemoveCount += 1;
      if (this.hitTestFailure && script.includes("function pickElementAt")) {
        throw new Error("hit-test failed");
      }
      return this.dom.window.eval(script);
    });
    this.capturePage = vi.fn(async () => captureImage());
    overlayTest.fakeGuests.push(this);
  }

  public getType(): string {
    return "webview";
  }

  public getURL(): string {
    return this.url;
  }

  public getTitle(): string {
    return "Example page";
  }

  public isDestroyed(): boolean {
    return this.destroyed;
  }
}

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents: vi.fn((sender: unknown) =>
      overlayTest.allWindows.find((window) => window.webContents === sender) ?? overlayTest.currentWindow,
    ),
  },
  app: { getPath: vi.fn(() => "C:\\temp") },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      overlayTest.ipcHandlers[channel] = handler;
    }),
  },
  session: {
    fromPartition: vi.fn(() => overlayTest.previewPartition),
  },
  webContents: {
    getAllWebContents: vi.fn(() => overlayTest.fakeGuests),
  },
}));

function captureImage(bytes = "png-bytes") {
  return {
    toPNG: vi.fn(() => Buffer.from(bytes)),
    getSize: vi.fn(() => ({ width: 100, height: 80 })),
  };
}

function makeWindow(id: number): FakeWindow {
  const window: FakeWindow = {
    id,
    destroyed: false,
    isDestroyed: () => window.destroyed,
    webContents: { isDestroyed: () => false, send: vi.fn() },
  };
  return window;
}

function makeSession(window: FakeWindow, activeTabId: string, tabIds: string[]): PreviewSession {
  const session = getSession(window as never);
  session.workspaceId = "workspace-A";
  session.lastPreviewThreadId = "thread-A";
  session.lastBounds = { x: 20, y: 30, width: 100, height: 80 };
  session.tabsByThread.set(previewTabScopeKey("workspace-A", "thread-A"), {
    threadId: "thread-A",
    activeTabId,
    tabs: tabIds.map((id, index) => ({
      id,
      threadId: "thread-A",
      resumeUrl: null,
      title: null,
      faviconUrl: null,
      lastActiveAt: tabIds.length - index,
    })),
  });
  return session;
}

function surface(tabId: string, generation = 1) {
  return {
    identity: {
      workspaceId: "workspace-A",
      scope: { kind: "thread" as const, id: "thread-A" },
      tabId,
    },
    generation,
  };
}

function invoke(channel: string, sender: FakeHostWebContents, payload?: unknown): unknown {
  const handler = overlayTest.ipcHandlers[channel];
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
  return handler({ sender } as unknown, payload);
}

function prepareAndAdopt(
  window: FakeWindow,
  tabId: string,
  guest: FakeGuest,
  adoptionToken: string,
  generation = 1,
): void {
  const payload = { surface: surface(tabId, generation), adoptionToken };
  expect(invoke("preview.surface.prepare", window.webContents, payload)).toEqual({ ok: true });
  expect(invoke("preview.surface.adopt", window.webContents, payload)).toEqual({ ok: true });
  guest.url = "https://example.test/page";
  expect(guest.hostWebContents).toBe(window.webContents);
}

async function waitForOverlayReady(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function commitRegion(guest: FakeGuest, rect: { x: number; y: number; width: number; height: number }): void {
  guest.dom.window.eval(`window.__mcodeRgState.commit = ${JSON.stringify(rect)}`);
}

function commitElement(guest: FakeGuest, x: number, y: number): void {
  guest.dom.window.eval(`window.__mcodeEpState.commit = { x: ${x}, y: ${y} }`);
}

function configureElementHitTest(guest: FakeGuest): void {
  const document = guest.dom.window.document;
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 100 });
  Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: 80 });
  const target = document.getElementById("target")!;
  target.getBoundingClientRect = () => ({
    x: -10,
    y: 6,
    width: 80,
    height: 90,
    left: -10,
    top: 6,
    right: 70,
    bottom: 96,
    toJSON: () => ({}),
  }) as DOMRect;
  Object.defineProperty(document, "elementsFromPoint", {
    configurable: true,
    value: () => [target],
  });
}

describe("Preview overlay capture handlers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    overlayTest.fakeGuests.length = 0;
    overlayTest.allWindows.length = 0;
    overlayTest.currentWindow = null;
    sessions.clear();
    _resetAdoptionRegistryForTests();
    registerPreviewSurfaceHandlers();
    registerOverlayHandlers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    _resetAdoptionRegistryForTests();
    sessions.clear();
  });

  it("captures a clamped region from the active adopted guest after removing its marquee", async () => {
    const window = makeWindow(11);
    overlayTest.allWindows.push(window);
    const session = makeSession(window, "tab-active", ["tab-active", "tab-inactive"]);
    const activeGuest = new FakeGuest(window, "active-token");
    const inactiveGuest = new FakeGuest(window, "inactive-token");
    prepareAndAdopt(window, "tab-active", activeGuest, "active-token");
    prepareAndAdopt(window, "tab-inactive", inactiveGuest, "inactive-token");
    let capturedBounds: unknown;
    activeGuest.capturePage.mockImplementation(async (bounds: unknown) => {
      capturedBounds = bounds;
      expect(activeGuest.dom.window.document.getElementById("__mcode_rg_layer")).toBeNull();
      expect(activeGuest.dom.window.document.getElementById("__mcode_rg_box")).toBeNull();
      return captureImage();
    });

    const pending = invoke("preview:capture-picture-region", window.webContents) as Promise<unknown>;
    await waitForOverlayReady();
    expect(activeGuest.dom.window.document.getElementById("__mcode_rg_layer")).not.toBeNull();
    commitRegion(activeGuest, { x: -2, y: 70, width: 40, height: 30 });
    await vi.advanceTimersByTimeAsync(120);

    const result = await pending as { ok: boolean; previewBytes?: Uint8Array; capture?: Record<string, unknown> };
    expect(result).toMatchObject({
      ok: true,
      capture: {
        captureKind: "region",
        bounds: { x: 0, y: 70, width: 40, height: 10 },
      },
    });
    expect([...result.previewBytes!]).toEqual([...Buffer.from("png-bytes")]);
    expect(capturedBounds).toEqual({ x: 0, y: 70, width: 40, height: 10 });
    expect(activeGuest.capturePage).toHaveBeenCalledOnce();
    expect(inactiveGuest.executeJavaScript).not.toHaveBeenCalled();
    expect(session.regionPollTimer).toBeNull();
  });

  it("returns selected-element context and clamps its capture bounds", async () => {
    const window = makeWindow(12);
    overlayTest.allWindows.push(window);
    const session = makeSession(window, "tab-active", ["tab-active"]);
    const guest = new FakeGuest(window, "active-token");
    configureElementHitTest(guest);
    prepareAndAdopt(window, "tab-active", guest, "active-token");
    guest.capturePage.mockImplementation(async (bounds: unknown) => {
      expect(guest.dom.window.document.getElementById("__mcode_ep_hl")).toBeNull();
      expect(guest.dom.window.document.getElementById("__mcode_ep_tip")).toBeNull();
      expect(bounds).toEqual({ x: 0, y: 6, width: 80, height: 74 });
      return captureImage();
    });

    const pending = invoke("preview:capture-picture-element-pick", window.webContents) as Promise<unknown>;
    await waitForOverlayReady();
    expect(guest.dom.window.document.getElementById("__mcode_ep_hl")).not.toBeNull();
    commitElement(guest, 20, 10);
    await vi.advanceTimersByTimeAsync(120);

    const result = await pending as { ok: boolean; capture?: Record<string, unknown> };
    expect(result).toMatchObject({
      ok: true,
      capture: {
        captureKind: "element",
        bounds: { x: 0, y: 6, width: 80, height: 74 },
        selectorHint: '[id="target"]',
        htmlExcerpt: '<button id="target">Target</button>',
        elementStyle: { width: "80px", height: "90px" },
      },
    });
    expect(guest.capturePage).toHaveBeenCalledOnce();
    expect(session.elementPickPollTimer).toBeNull();
  });

  it("does not install a late region overlay after cancellation during injection", async () => {
    const window = makeWindow(19);
    overlayTest.allWindows.push(window);
    const session = makeSession(window, "tab-active", ["tab-active"]);
    const guest = new FakeGuest(window, "active-token");
    let releaseInjection!: () => void;
    guest.injectionMode = "region";
    guest.injectionGate = new Promise<void>((resolve) => { releaseInjection = resolve; });
    prepareAndAdopt(window, "tab-active", guest, "active-token");

    const pending = invoke("preview:capture-picture-region", window.webContents) as Promise<unknown>;
    await waitForOverlayReady();
    await invoke("preview:cancel-capture", window.webContents);
    releaseInjection();
    await vi.advanceTimersByTimeAsync(0);

    expect(await pending).toEqual({ ok: false, error: "cancelled" });
    expect(guest.dom.window.document.getElementById("__mcode_rg_layer")).toBeNull();
    expect(session.regionPollTimer).toBeNull();
  });

  it("does not schedule a late element poll after injection loses its adopted surface", async () => {
    const window = makeWindow(20);
    overlayTest.allWindows.push(window);
    const session = makeSession(window, "tab-active", ["tab-active"]);
    const guest = new FakeGuest(window, "old-token");
    let releaseInjection!: () => void;
    guest.injectionMode = "element";
    guest.injectionGate = new Promise<void>((resolve) => { releaseInjection = resolve; });
    prepareAndAdopt(window, "tab-active", guest, "old-token");

    const pending = invoke("preview:capture-picture-element-pick", window.webContents) as Promise<unknown>;
    await waitForOverlayReady();
    const replacement = new FakeGuest(window, "replacement-token");
    prepareAndAdopt(window, "tab-active", replacement, "replacement-token", 2);
    releaseInjection();
    await vi.advanceTimersByTimeAsync(0);

    expect(await pending).toEqual({ ok: false, error: "no-preview" });
    expect(guest.dom.window.document.getElementById("__mcode_ep_hl")).toBeNull();
    expect(guest.elementRemoveCount).toBe(1);
    expect(session.elementPickPollTimer).toBeNull();
    expect(replacement.executeJavaScript).not.toHaveBeenCalled();
  });

  it("aborts an active capture when the adopted guest starts main-frame navigation", async () => {
    const window = makeWindow(13);
    overlayTest.allWindows.push(window);
    const session = makeSession(window, "tab-active", ["tab-active"]);
    const guest = new FakeGuest(window, "active-token");
    prepareAndAdopt(window, "tab-active", guest, "active-token");

    const pending = invoke("preview:capture-picture-region", window.webContents) as Promise<unknown>;
    await waitForOverlayReady();
    guest.emit("did-start-navigation", {}, "https://example.test/next", false, true);
    const result = await pending;
    await vi.advanceTimersByTimeAsync(0);

    expect(result).toEqual({ ok: false, error: "navigated-away" });
    expect(guest.dom.window.document.getElementById("__mcode_rg_layer")).toBeNull();
    expect(guest.capturePage).not.toHaveBeenCalled();
    expect(session.regionPollTimer).toBeNull();
  });

  it("rejects a region capture when its surface is replaced before capturePage", async () => {
    const window = makeWindow(21);
    overlayTest.allWindows.push(window);
    const session = makeSession(window, "tab-active", ["tab-active"]);
    const guest = new FakeGuest(window, "old-token");
    let replaced = false;
    guest.executeJavaScript.mockImplementation(async (script: string) => {
      if (!replaced && script.includes("typeof window.__mcodeRgTeardown")) {
        replaced = true;
        const replacement = new FakeGuest(window, "replacement-token");
        prepareAndAdopt(window, "tab-active", replacement, "replacement-token", 2);
      }
      return guest.dom.window.eval(script);
    });
    prepareAndAdopt(window, "tab-active", guest, "old-token");

    const pending = invoke("preview:capture-picture-region", window.webContents) as Promise<unknown>;
    await waitForOverlayReady();
    commitRegion(guest, { x: 10, y: 10, width: 20, height: 20 });
    await vi.advanceTimersByTimeAsync(120);

    expect(await pending).toEqual({ ok: false, error: "no-preview" });
    expect(guest.capturePage).not.toHaveBeenCalled();
    expect(session.regionPollTimer).toBeNull();
  });

  it("rejects an element capture when navigation starts before capturePage", async () => {
    const window = makeWindow(22);
    overlayTest.allWindows.push(window);
    const session = makeSession(window, "tab-active", ["tab-active"]);
    const guest = new FakeGuest(window, "active-token");
    configureElementHitTest(guest);
    let navigated = false;
    guest.executeJavaScript.mockImplementation(async (script: string) => {
      if (!navigated && script.includes("typeof window.__mcodeEpTeardown")) {
        navigated = true;
        guest.emit("did-start-navigation", {}, "https://example.test/next", false, true);
      }
      return guest.dom.window.eval(script);
    });
    prepareAndAdopt(window, "tab-active", guest, "active-token");

    const pending = invoke("preview:capture-picture-element-pick", window.webContents) as Promise<unknown>;
    await waitForOverlayReady();
    commitElement(guest, 20, 10);
    await vi.advanceTimersByTimeAsync(120);

    expect(await pending).toEqual({ ok: false, error: "navigated-away" });
    expect(guest.capturePage).not.toHaveBeenCalled();
    expect(guest.dom.window.document.getElementById("__mcode_ep_hl")).toBeNull();
    expect(session.elementPickPollTimer).toBeNull();
  });

  it("cancels a capture and ignores a stale poll result", async () => {
    const window = makeWindow(14);
    overlayTest.allWindows.push(window);
    const session = makeSession(window, "tab-active", ["tab-active"]);
    const guest = new FakeGuest(window, "active-token");
    prepareAndAdopt(window, "tab-active", guest, "active-token");
    let releasePoll!: (value: string) => void;
    const poll = new Promise<string>((resolve) => { releasePoll = resolve; });
    guest.executeJavaScript.mockImplementation(async (script: string) => {
      if (script.includes('if (!st) return JSON.stringify({ state: "gone" });')) return poll;
      return guest.dom.window.eval(script);
    });

    const pending = invoke("preview:capture-picture-region", window.webContents) as Promise<unknown>;
    await waitForOverlayReady();
    await vi.advanceTimersByTimeAsync(120);
    await invoke("preview:cancel-capture", window.webContents);
    releasePoll(JSON.stringify({ state: "commit", seq: 1, x: 1, y: 1, width: 20, height: 20 }));
    await vi.advanceTimersByTimeAsync(0);

    expect(await pending).toEqual({ ok: false, error: "cancelled" });
    expect(guest.dom.window.document.getElementById("__mcode_rg_layer")).toBeNull();
    expect(guest.capturePage).not.toHaveBeenCalled();
    expect(session.regionPollTimer).toBeNull();
    const callsAfterCancel = guest.executeJavaScript.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(guest.executeJavaScript).toHaveBeenCalledTimes(callsAfterCancel);
  });

  it("removes the element highlighter and stops polling after hit-test script failure", async () => {
    const window = makeWindow(15);
    overlayTest.allWindows.push(window);
    const session = makeSession(window, "tab-active", ["tab-active"]);
    const guest = new FakeGuest(window, "active-token");
    configureElementHitTest(guest);
    guest.hitTestFailure = true;
    prepareAndAdopt(window, "tab-active", guest, "active-token");

    const pending = invoke("preview:capture-picture-element-pick", window.webContents) as Promise<unknown>;
    await waitForOverlayReady();
    commitElement(guest, 20, 10);
    await vi.advanceTimersByTimeAsync(120);

    expect(await pending).toEqual({ ok: false, error: "no-hit" });
    expect(guest.dom.window.document.getElementById("__mcode_ep_hl")).toBeNull();
    expect(guest.capturePage).not.toHaveBeenCalled();
    expect(session.elementPickPollTimer).toBeNull();
  });

  it("removes the region marquee and stops polling after capture failure", async () => {
    const window = makeWindow(16);
    overlayTest.allWindows.push(window);
    const session = makeSession(window, "tab-active", ["tab-active"]);
    const guest = new FakeGuest(window, "active-token");
    guest.capturePage.mockRejectedValue(new Error("capture failed"));
    prepareAndAdopt(window, "tab-active", guest, "active-token");

    const pending = invoke("preview:capture-picture-region", window.webContents) as Promise<unknown>;
    await waitForOverlayReady();
    commitRegion(guest, { x: 10, y: 10, width: 20, height: 20 });
    await vi.advanceTimersByTimeAsync(120);

    expect(await pending).toEqual({ ok: false, error: "capture-failed" });
    expect(guest.dom.window.document.getElementById("__mcode_rg_layer")).toBeNull();
    expect(guest.capturePage).toHaveBeenCalledOnce();
    expect(session.regionPollTimer).toBeNull();
  });

  it("fails without capture effects when the adopted surface is destroyed", async () => {
    const window = makeWindow(17);
    overlayTest.allWindows.push(window);
    makeSession(window, "tab-active", ["tab-active"]);
    const guest = new FakeGuest(window, "active-token");
    prepareAndAdopt(window, "tab-active", guest, "active-token");
    guest.destroyed = true;
    guest.emit("destroyed");

    expect(await invoke("preview:capture-picture-region", window.webContents)).toEqual({
      ok: false,
      error: "no-preview",
    });
    expect(guest.executeJavaScript).not.toHaveBeenCalled();
    expect(guest.capturePage).not.toHaveBeenCalled();
  });

  it("fails a pending capture when its adopted surface is replaced", async () => {
    const window = makeWindow(18);
    overlayTest.allWindows.push(window);
    const session = makeSession(window, "tab-active", ["tab-active"]);
    const oldGuest = new FakeGuest(window, "old-token");
    prepareAndAdopt(window, "tab-active", oldGuest, "old-token");

    const pending = invoke("preview:capture-picture-region", window.webContents) as Promise<unknown>;
    await waitForOverlayReady();
    const replacementGuest = new FakeGuest(window, "replacement-token");
    prepareAndAdopt(window, "tab-active", replacementGuest, "replacement-token", 2);
    commitRegion(oldGuest, { x: 10, y: 10, width: 20, height: 20 });
    await vi.advanceTimersByTimeAsync(120);

    expect(await pending).toEqual({ ok: false, error: "no-preview" });
    expect(oldGuest.capturePage).not.toHaveBeenCalled();
    expect(replacementGuest.executeJavaScript).not.toHaveBeenCalled();
    expect(session.regionPollTimer).toBeNull();
  });
});
