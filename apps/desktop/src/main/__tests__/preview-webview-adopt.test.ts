import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * Tracks ipc handlers registered via the mocked electron module so tests can
 * call them directly without spinning up an actual Electron runtime.
 */
const ipcHandlers: Record<string, (...args: unknown[]) => unknown> = {};

interface FakeWebContents {
  id: number;
  destroyed: boolean;
  url: string;
  title: string;
  listeners: Map<string, Set<(...args: unknown[]) => void>>;
  isDestroyed: () => boolean;
  getURL: () => string;
  getTitle: () => string;
  getType: () => string;
  hostWebContents: unknown;
  session: object;
  setWindowOpenHandler: ReturnType<typeof vi.fn>;
  on: (event: string, cb: (...args: unknown[]) => void) => void;
  once: (event: string, cb: (...args: unknown[]) => void) => void;
  removeListener: (event: string, cb: (...args: unknown[]) => void) => void;
  emit: (event: string, ...args: unknown[]) => void;
}

function makeFakeWebContents(
  id: number,
  overrides: Partial<Pick<FakeWebContents, "getType" | "hostWebContents" | "session">> = {},
): FakeWebContents {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    id,
    destroyed: false,
    url: `https://t.test/${id}`,
    title: `Tab ${id}`,
    listeners,
    isDestroyed() {
      return this.destroyed;
    },
    getURL() {
      return this.url;
    },
    getTitle() {
      return this.title;
    },
    getType: overrides.getType ?? (() => "webview"),
    hostWebContents: overrides.hostWebContents ?? allWindows[0]?.webContents,
    session: overrides.session ?? previewPartition,
    setWindowOpenHandler: vi.fn(),
    on(event, cb) {
      let bag = listeners.get(event);
      if (!bag) {
        bag = new Set();
        listeners.set(event, bag);
      }
      bag.add(cb);
    },
    once(event, cb) {
      let bag = listeners.get(event);
      if (!bag) {
        bag = new Set();
        listeners.set(event, bag);
      }
      const wrapper = (...args: unknown[]) => {
        bag!.delete(wrapper);
        cb(...args);
      };
      bag.add(wrapper);
    },
    removeListener(event, cb) {
      const bag = listeners.get(event);
      if (!bag) return;
      // Real Electron matches by reference; our once-wrapper means callers
      // typically remove by passing the same wrapper they got. For the test
      // it's enough to clear all listeners on that event.
      for (const w of bag) {
        if (w === cb) bag.delete(w);
      }
    },
    emit(event, ...args) {
      const bag = listeners.get(event);
      if (!bag) return;
      for (const cb of [...bag]) cb(...args);
    },
  };
}

const fakeWebContentsRegistry = new Map<number, FakeWebContents>();
const previewPartition = {};

function makeWindow(id: number) {
  return {
    id,
    isDestroyed: () => false,
    isFocused: () => true,
    webContents: { isDestroyed: () => false, send: vi.fn() },
  };
}

const allWindows: Array<ReturnType<typeof makeWindow>> = [];

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents: vi.fn((sender: unknown) => allWindows.find((window) => window.webContents === sender) ?? null),
    getAllWindows: vi.fn(() => allWindows),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers[channel] = handler;
    }),
  },
  session: {
    fromPartition: vi.fn((partition: string) => partition === "persist:mcode-preview" ? previewPartition : {}),
  },
  webContents: {
    fromId: vi.fn((id: number) => fakeWebContentsRegistry.get(id) ?? null),
  },
}));

vi.mock("@mcode/shared", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  _resetAdoptionRegistryForTests,
  findAdoptedWebContentsForWindow,
  registerWebviewAdoptHandlers,
} from "../preview/preview-webview-adopt.js";
import { getSession, sessions } from "../preview/preview-session.js";

beforeEach(() => {
  fakeWebContentsRegistry.clear();
  allWindows.length = 0;
  allWindows.push(makeWindow(1));
  const session = getSession(allWindows[0] as never);
  session.tabsByThread.clear();
  session.tabsByThread.set("thread-A", {
    threadId: "thread-A",
    activeTabId: "tab-1",
    tabs: [{
      id: "tab-1",
      threadId: "thread-A",
      view: null,
      resumeUrl: null,
      title: null,
      faviconUrl: null,
      lastActiveAt: 0,
    }],
  });
  _resetAdoptionRegistryForTests();
});

afterEach(() => {
  _resetAdoptionRegistryForTests();
  sessions.clear();
});

describe("preview-webview-adopt", () => {
  let registered = false;
  beforeEach(() => {
    if (!registered) {
      registerWebviewAdoptHandlers();
      registered = true;
    }
  });

  function fakeEvent() {
    return { sender: allWindows[0]!.webContents } as unknown;
  }

  it("registers a WebContents under (threadId, tabId) and locates it", () => {
    const wc = makeFakeWebContents(42);
    fakeWebContentsRegistry.set(42, wc);

    const result = ipcHandlers["preview:adopt-webview"]!(fakeEvent(), {
      webContentsId: 42,
      threadId: "thread-A",
      tabId: "tab-1",
    });
    expect(result).toEqual({ ok: true });

    const located = findAdoptedWebContentsForWindow(1, "thread-A", "tab-1");
    expect(located).toBe(wc);
  });

  it("rejects invalid webContentsId / threadId / tabId", () => {
    expect(
      ipcHandlers["preview:adopt-webview"]!(fakeEvent(), {
        webContentsId: 0,
        threadId: "t",
        tabId: "x",
      }),
    ).toMatchObject({ ok: false });
    expect(
      ipcHandlers["preview:adopt-webview"]!(fakeEvent(), {
        webContentsId: 1,
        threadId: "",
        tabId: "x",
      }),
    ).toMatchObject({ ok: false });
    expect(
      ipcHandlers["preview:adopt-webview"]!(fakeEvent(), {
        webContentsId: 1,
        threadId: "t",
        tabId: "",
      }),
    ).toMatchObject({ ok: false });
    expect(
      ipcHandlers["preview:adopt-webview"]!(fakeEvent(), {
        webContentsId: Number.MAX_SAFE_INTEGER + 1,
        threadId: "t",
        tabId: "x",
      }),
    ).toEqual({ ok: false, error: "invalid-webcontents-id" });
    expect(
      ipcHandlers["preview:adopt-webview"]!(fakeEvent(), {
        webContentsId: 1.5,
        threadId: "t",
        tabId: "x",
      }),
    ).toEqual({ ok: false, error: "invalid-webcontents-id" });
    expect(
      ipcHandlers["preview:adopt-webview"]!(fakeEvent(), {
        webContentsId: 1,
        threadId: "t".repeat(257),
        tabId: "x",
      }),
    ).toEqual({ ok: false, error: "invalid-thread-id" });
  });

  it("returns webcontents-not-found when fromId returns nothing", () => {
    const result = ipcHandlers["preview:adopt-webview"]!(fakeEvent(), {
      webContentsId: 999,
      threadId: "thread-A",
      tabId: "tab-1",
    });
    expect(result).toMatchObject({ ok: false, error: "webcontents-not-found" });
  });

  it.each([
    [
      "a non-webview WebContents",
      { getType: () => "window" },
      "invalid-webcontents-type",
    ],
    [
      "a webview hosted by another sender",
      { hostWebContents: { id: "other-window" } },
      "webcontents-owner-mismatch",
    ],
    [
      "a webview in another partition",
      { session: {} },
      "invalid-webcontents-partition",
    ],
  ])("rejects %s", (_label, overrides, expectedError) => {
    const wc = makeFakeWebContents(43, overrides);
    fakeWebContentsRegistry.set(43, wc);

    const result = ipcHandlers["preview:adopt-webview"]!(fakeEvent(), {
      webContentsId: 43,
      threadId: "thread-A",
      tabId: "tab-1",
    });

    expect(result).toEqual({ ok: false, error: expectedError });
    expect(findAdoptedWebContentsForWindow(1, "thread-A", "tab-1")).toBeNull();
  });

  it.each([
    ["wrong-thread", "tab-1"],
    ["thread-A", "wrong-tab"],
  ])("rejects an adoption for a missing exact slot (%s/%s)", (threadId, tabId) => {
    const wc = makeFakeWebContents(44);
    fakeWebContentsRegistry.set(44, wc);
    expect(ipcHandlers["preview:adopt-webview"]!(fakeEvent(), {
      webContentsId: 44,
      threadId,
      tabId,
    })).toEqual({ ok: false, error: "target-slot-not-found" });
  });

  it("keeps colliding thread and tab ids isolated by BrowserWindow", () => {
    const secondWindow = makeWindow(2);
    allWindows.push(secondWindow);
    const secondSession = getSession(secondWindow as never);
    secondSession.tabsByThread.set("thread-A", {
      threadId: "thread-A",
      activeTabId: "tab-1",
      tabs: [{ id: "tab-1", threadId: "thread-A", view: null, resumeUrl: null, title: null, faviconUrl: null, lastActiveAt: 0 }],
    });
    const first = makeFakeWebContents(45);
    const second = makeFakeWebContents(46, { hostWebContents: secondWindow.webContents });
    fakeWebContentsRegistry.set(45, first);
    fakeWebContentsRegistry.set(46, second);
    ipcHandlers["preview:adopt-webview"]!({ sender: allWindows[0]!.webContents }, { webContentsId: 45, threadId: "thread-A", tabId: "tab-1" });
    ipcHandlers["preview:adopt-webview"]!({ sender: secondWindow.webContents }, { webContentsId: 46, threadId: "thread-A", tabId: "tab-1" });
    expect(findAdoptedWebContentsForWindow(1, "thread-A", "tab-1")).toBe(first);
    expect(findAdoptedWebContentsForWindow(2, "thread-A", "tab-1")).toBe(second);
  });

  it("keeps adversarial colon-delimited ids in distinct slots", () => {
    const session = getSession(allWindows[0] as never);
    session.tabsByThread.set("a:b", {
      threadId: "a:b",
      activeTabId: "c",
      tabs: [{ id: "c", threadId: "a:b", view: null, resumeUrl: null, title: null, faviconUrl: null, lastActiveAt: 0 }],
    });
    session.tabsByThread.set("a", {
      threadId: "a",
      activeTabId: "b:c",
      tabs: [{ id: "b:c", threadId: "a", view: null, resumeUrl: null, title: null, faviconUrl: null, lastActiveAt: 0 }],
    });
    const first = makeFakeWebContents(47);
    const second = makeFakeWebContents(48);
    fakeWebContentsRegistry.set(47, first);
    fakeWebContentsRegistry.set(48, second);
    ipcHandlers["preview:adopt-webview"]!(fakeEvent(), { webContentsId: 47, threadId: "a:b", tabId: "c" });
    ipcHandlers["preview:adopt-webview"]!(fakeEvent(), { webContentsId: 48, threadId: "a", tabId: "b:c" });
    expect(findAdoptedWebContentsForWindow(1, "a:b", "c")).toBe(first);
    expect(findAdoptedWebContentsForWindow(1, "a", "b:c")).toBe(second);
  });

  it("drops the registration when the adopted WebContents emits 'destroyed'", () => {
    const wc = makeFakeWebContents(7);
    fakeWebContentsRegistry.set(7, wc);

    ipcHandlers["preview:adopt-webview"]!(fakeEvent(), {
      webContentsId: 7,
      threadId: "thread-A",
      tabId: "tab-1",
    });
    expect(findAdoptedWebContentsForWindow(1, "thread-A", "tab-1")).toBe(wc);

    wc.destroyed = true;
    wc.emit("destroyed");
    expect(findAdoptedWebContentsForWindow(1, "thread-A", "tab-1")).toBeNull();
  });

  it("preview:release-webview drops the slot", () => {
    const wc = makeFakeWebContents(11);
    fakeWebContentsRegistry.set(11, wc);
    ipcHandlers["preview:adopt-webview"]!(fakeEvent(), {
      webContentsId: 11,
      threadId: "thread-A",
      tabId: "tab-1",
    });
    expect(findAdoptedWebContentsForWindow(1, "thread-A", "tab-1")).toBe(wc);

    const released = ipcHandlers["preview:release-webview"]!(fakeEvent(), {
      threadId: "thread-A",
      tabId: "tab-1",
    });
    expect(released).toEqual({ ok: true });
    expect(findAdoptedWebContentsForWindow(1, "thread-A", "tab-1")).toBeNull();
  });

  it("re-adopting the same slot replaces the prior registration", () => {
    const wc1 = makeFakeWebContents(20);
    const wc2 = makeFakeWebContents(21);
    fakeWebContentsRegistry.set(20, wc1);
    fakeWebContentsRegistry.set(21, wc2);

    ipcHandlers["preview:adopt-webview"]!(fakeEvent(), {
      webContentsId: 20,
      threadId: "thread-A",
      tabId: "tab-1",
    });
    ipcHandlers["preview:adopt-webview"]!(fakeEvent(), {
      webContentsId: 21,
      threadId: "thread-A",
      tabId: "tab-1",
    });

    expect(findAdoptedWebContentsForWindow(1, "thread-A", "tab-1")).toBe(wc2);
  });
});
