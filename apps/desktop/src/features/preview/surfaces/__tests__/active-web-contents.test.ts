import * as NodeEvents from "node:events";
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
} from "../registry.js";
import { resolveActivePreviewWebContents } from "../active-web-contents.js";

const ipcHandlers: Record<string, (...args: unknown[]) => unknown> = {};
const fakeGuests: FakeGuest[] = [];
const allWindows: FakeWindow[] = [];
const previewPartition = {
  setPermissionCheckHandler: vi.fn(),
  setPermissionRequestHandler: vi.fn(),
  on: vi.fn(),
  clearStorageData: vi.fn(async () => undefined),
  clearCache: vi.fn(async () => undefined),
};

interface FakeWindow {
  id: number;
  isDestroyed: () => boolean;
  isFocused: () => boolean;
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
  public readonly id: number;
  public readonly setWindowOpenHandler = vi.fn();

  public constructor(host: FakeWindow, id: number, adoptionToken: string) {
    super();
    this.hostWebContents = host.webContents;
    this.id = id;
    this.url = `about:blank#${adoptionToken}`;
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
  return {
    id,
    isDestroyed: () => false,
    isFocused: () => true,
    webContents: { isDestroyed: () => false, send: vi.fn() },
  };
}

function surface(tabId: string) {
  return {
    identity: {
      workspaceId: "workspace-A",
      scope: { kind: "thread" as const, id: "thread-A" },
      tabId,
    },
    generation: 1,
  };
}

function invoke(channel: string, payload: unknown, sender: FakeHostWebContents): unknown {
  return ipcHandlers[channel]!({ sender } as unknown, payload);
}

function makeSession(
  window: FakeWindow,
  activeTabId: string,
  tabIds: string[],
): PreviewSession {
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

function prepareAndAdopt(
  window: FakeWindow,
  tabId: string,
  adoptionToken: string,
): void {
  const payload = { surface: surface(tabId), adoptionToken };
  expect(invoke("preview.surface.prepare", payload, window.webContents)).toEqual({ ok: true });
  expect(invoke("preview.surface.adopt", payload, window.webContents)).toEqual({ ok: true });
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

describe("active Preview guest resolution", () => {
  beforeEach(() => {
    fakeGuests.length = 0;
    allWindows.length = 0;
    sessions.clear();
    _resetAdoptionRegistryForTests();
    registerPreviewSurfaceHandlers();
  });

  it("returns only the adopted guest for the active tab", () => {
    const window = makeWindow(11);
    allWindows.push(window);
    const session = makeSession(window, "tab-active", ["tab-active", "tab-inactive"]);
    const activeGuest = new FakeGuest(window, 101, "active-token");
    const inactiveGuest = new FakeGuest(window, 102, "inactive-token");

    prepareAndAdopt(window, "tab-active", "active-token");
    prepareAndAdopt(window, "tab-inactive", "inactive-token");

    expect(resolveActivePreviewWebContents(session)).toBe(activeGuest);
    expect(resolveActivePreviewWebContents(session)).not.toBe(inactiveGuest);
  });

  it("returns null when the active guest is destroyed", () => {
    const window = makeWindow(12);
    allWindows.push(window);
    const session = makeSession(window, "tab-active", ["tab-active"]);
    const guest = new FakeGuest(window, 103, "active-token");
    prepareAndAdopt(window, "tab-active", "active-token");
    expect(resolveActivePreviewWebContents(session)).toBe(guest);

    guest.destroyed = true;
    guest.emit("destroyed");
    expect(resolveActivePreviewWebContents(session)).toBeNull();
  });

  it("returns null when no Preview thread is active", () => {
    const session = { lastPreviewThreadId: null } as never;

    expect(resolveActivePreviewWebContents(session)).toBeNull();
  });
});
