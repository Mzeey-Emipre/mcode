import * as NodeEvents from "node:events";
import { JSDOM } from "jsdom";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
import { registerDesignModeHandlers } from "../handlers.js";

const ipcHandlers: Record<string, (...args: unknown[]) => unknown> = {};
const fakeGuests: FakeGuest[] = [];
const allWindows: FakeWindow[] = [];
const previewPartition = {};

interface FakeWindow {
  id: number;
  destroyed: boolean;
  isDestroyed: () => boolean;
  webContents: FakeHostWebContents;
}

interface FakeHostWebContents {
  isDestroyed: () => boolean;
  send: ReturnType<typeof vi.fn>;
}

class FakeGuest extends NodeEvents.EventEmitter {
  public destroyed = false;
  public url: string;
  public readonly hostWebContents: FakeHostWebContents;
  public readonly session = previewPartition;
  public readonly dom: JSDOM;
  public readonly executeJavaScript: ReturnType<typeof vi.fn>;
  public readonly setWindowOpenHandler = vi.fn();

  public constructor(host: FakeWindow, adoptionToken: string) {
    super();
    this.hostWebContents = host.webContents;
    this.url = `about:blank#${adoptionToken}`;
    this.dom = new JSDOM("<!doctype html><html><body><button id='target'>Target</button></body></html>", {
      runScripts: "outside-only",
    });
    this.executeJavaScript = vi.fn(async (script: string, _userGesture: boolean) => this.dom.window.eval(script));
    fakeGuests.push(this);
  }

  public getType(): string {
    return "webview";
  }

  public getURL(): string {
    return this.url;
  }

  public isDestroyed(): boolean {
    return this.destroyed;
  }
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

function invoke(channel: string, payload: unknown, sender: FakeHostWebContents): unknown {
  return ipcHandlers[channel]!({ sender } as unknown, payload);
}

function prepareAndAdopt(window: FakeWindow, tabId: string, adoptionToken: string, generation = 1): void {
  const payload = { surface: surface(tabId, generation), adoptionToken };
  expect(invoke("preview.surface.prepare", payload, window.webContents)).toEqual({ ok: true });
  expect(invoke("preview.surface.adopt", payload, window.webContents)).toEqual({ ok: true });
}

function pageValue(guest: FakeGuest, name: string): unknown {
  return (guest.dom.window as unknown as Record<string, unknown>)[name];
}

function inspectOverlay(guest: FakeGuest): HTMLElement | null {
  return guest.dom.window.document.querySelector("html > div");
}

function dispatchClick(guest: FakeGuest): { event: MouseEvent; listener: ReturnType<typeof vi.fn> } {
  const target = guest.dom.window.document.getElementById("target")!;
  const listener = vi.fn();
  target.addEventListener("click", listener);
  const event = new guest.dom.window.MouseEvent("click", { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  target.removeEventListener("click", listener);
  return { event, listener };
}

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents: vi.fn((sender: unknown) =>
      allWindows.find((window) => window.webContents === sender) ?? null,
    ),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers[channel] = handler;
    }),
  },
  session: {
    fromPartition: vi.fn(() => previewPartition),
  },
  webContents: {
    getAllWebContents: vi.fn(() => fakeGuests),
  },
}));

describe("Preview design mode handlers", () => {
  beforeEach(() => {
    fakeGuests.length = 0;
    allWindows.length = 0;
    sessions.clear();
    _resetAdoptionRegistryForTests();
    registerPreviewSurfaceHandlers();
    registerDesignModeHandlers();
  });

  it("enables and disables inspect only on the active adopted guest", async () => {
    const window = makeWindow(11);
    allWindows.push(window);
    makeSession(window, "tab-active", ["tab-active", "tab-inactive"]);
    const activeGuest = new FakeGuest(window, "active-token");
    const inactiveGuest = new FakeGuest(window, "inactive-token");
    prepareAndAdopt(window, "tab-active", "active-token");
    prepareAndAdopt(window, "tab-inactive", "inactive-token");

    expect(await invoke("preview:design.set-inspect", { enabled: true }, window.webContents)).toEqual({ ok: true });
    expect(activeGuest.executeJavaScript).toHaveBeenCalledTimes(1);
    expect(pageValue(activeGuest, "__mcodeInspectActive")).toBe(true);
    const overlay = inspectOverlay(activeGuest);
    expect(overlay).not.toBeNull();
    activeGuest.dom.window.document.getElementById("target")!.dispatchEvent(
      new activeGuest.dom.window.MouseEvent("mousemove", { bubbles: true }),
    );
    expect((overlay as HTMLElement).style.display).toBe("block");
    expect(inactiveGuest.executeJavaScript).not.toHaveBeenCalled();
    expect(pageValue(inactiveGuest, "__mcodeInspectActive")).toBeUndefined();
    expect(inspectOverlay(inactiveGuest)).toBeNull();

    expect(await invoke("preview:design.set-inspect", { enabled: false }, window.webContents)).toEqual({ ok: true });
    expect(activeGuest.executeJavaScript).toHaveBeenCalledTimes(2);
    expect(pageValue(activeGuest, "__mcodeInspectActive")).toBeUndefined();
    expect(pageValue(activeGuest, "__mcodeInspectTeardown")).toBeUndefined();
    expect(inspectOverlay(activeGuest)).toBeNull();
    overlay!.style.display = "none";
    activeGuest.dom.window.document.getElementById("target")!.dispatchEvent(
      new activeGuest.dom.window.MouseEvent("mousemove", { bubbles: true }),
    );
    expect(overlay!.style.display).toBe("none");
  }, 15_000);

  it("enables and disables the annotation guard on the active adopted guest", async () => {
    const window = makeWindow(13);
    allWindows.push(window);
    makeSession(window, "tab-active", ["tab-active", "tab-inactive"]);
    const activeGuest = new FakeGuest(window, "active-token");
    const inactiveGuest = new FakeGuest(window, "inactive-token");
    prepareAndAdopt(window, "tab-active", "active-token");
    prepareAndAdopt(window, "tab-inactive", "inactive-token");

    expect(await invoke("preview:design.set-annotation-guard", { enabled: true }, window.webContents)).toEqual({ ok: true });
    expect(pageValue(activeGuest, "__mcodeAnnotationGuardActive")).toBe(true);
    const blocked = dispatchClick(activeGuest);
    expect(blocked.event.defaultPrevented).toBe(true);
    expect(blocked.listener).not.toHaveBeenCalled();
    const inactive = dispatchClick(inactiveGuest);
    expect(inactive.event.defaultPrevented).toBe(false);
    expect(inactive.listener).toHaveBeenCalledTimes(1);
    expect(pageValue(inactiveGuest, "__mcodeAnnotationGuardActive")).toBeUndefined();

    expect(await invoke("preview:design.set-annotation-guard", { enabled: false }, window.webContents)).toEqual({ ok: true });
    expect(pageValue(activeGuest, "__mcodeAnnotationGuardActive")).toBeUndefined();
    expect(pageValue(activeGuest, "__mcodeAnnotationGuardTeardown")).toBeUndefined();
    const restored = dispatchClick(activeGuest);
    expect(restored.event.defaultPrevented).toBe(false);
    expect(restored.listener).toHaveBeenCalledTimes(1);
    expect(activeGuest.executeJavaScript).toHaveBeenCalledTimes(2);
    expect(inactiveGuest.executeJavaScript).not.toHaveBeenCalled();
  }, 15_000);

  it("returns explicit failures for unavailable windows, guests, and scripts", async () => {
    const missingWindowSender = { isDestroyed: () => false, send: vi.fn() };
    expect(await invoke("preview:design.set-inspect", { enabled: true }, missingWindowSender)).toEqual({
      ok: false,
      error: "no-window",
    });

    const window = makeWindow(14);
    allWindows.push(window);
    makeSession(window, "tab-active", ["tab-active"]);
    expect(await invoke("preview:design.set-inspect", { enabled: true }, window.webContents)).toEqual({
      ok: false,
      error: "no-view",
    });

    const guest = new FakeGuest(window, "active-token");
    prepareAndAdopt(window, "tab-active", "active-token");
    guest.destroyed = true;
    guest.emit("destroyed");
    expect(await invoke("preview:design.set-annotation-guard", { enabled: true }, window.webContents)).toEqual({
      ok: false,
      error: "no-view",
    });

    const liveGuest = new FakeGuest(window, "replacement-token");
    prepareAndAdopt(window, "tab-active", "replacement-token", 2);
    liveGuest.executeJavaScript.mockRejectedValueOnce(new Error("guest rejected"));
    expect(await invoke("preview:design.set-inspect", { enabled: true }, window.webContents)).toEqual({
      ok: false,
      error: "script-failed",
    });
    liveGuest.executeJavaScript.mockRejectedValueOnce(new Error("guest rejected annotation guard"));
    expect(await invoke("preview:design.set-annotation-guard", { enabled: true }, window.webContents)).toEqual({
      ok: false,
      error: "script-failed",
    });

    window.destroyed = true;
    expect(await invoke("preview:design.set-annotation-guard", { enabled: true }, window.webContents)).toEqual({
      ok: false,
      error: "no-window",
    });
  });
});
