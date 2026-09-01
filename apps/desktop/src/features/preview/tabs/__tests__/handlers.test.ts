import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcHandlers: Record<string, (...args: any[]) => unknown> = {};

interface FakeWindow {
  id: number;
  isDestroyed: () => boolean;
  webContents: { send: ReturnType<typeof vi.fn> };
}

const window = {
  id: 1,
  isDestroyed: () => false,
  webContents: { send: vi.fn() },
} satisfies FakeWindow;

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents: vi.fn((sender: unknown) => sender === window.webContents ? window : null),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => {
      ipcHandlers[channel] = handler;
    }),
  },
}));

vi.mock("@mcode/shared", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { registerTabHandlers } from "../handlers.js";
import { getSession, previewTabScopeKey, sessions } from "../../state/window-session.js";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

const SAFE_LOCAL_PAGE_URL = new URL(
  "../../../../../../web/public/browser-automation-fixture.html",
  import.meta.url,
).href;

function invoke<T>(channel: string, payload: Record<string, unknown>): Result<T> {
  return ipcHandlers[channel]!({ sender: window.webContents }, payload) as Result<T>;
}

async function invokeAsync<T>(channel: string, payload: Record<string, unknown>): Promise<Result<T>> {
  const result = await ipcHandlers[channel]!({ sender: window.webContents }, payload);
  return result as Result<T>;
}

beforeEach(() => {
  window.webContents.send.mockClear();
  sessions.clear();
  registerTabHandlers();
});

afterEach(() => {
  sessions.clear();
});

describe("preview tab handlers", () => {
  it("materializes an isolated tab set for each workspace and scope", () => {
    const first = invoke<{ activeTabId: string; tabs: unknown[] }>("preview:tabs.list", {
      workspaceId: "workspace-A",
      threadId: "thread-A",
    });
    const second = invoke<{ activeTabId: string; tabs: unknown[] }>("preview:tabs.list", {
      workspaceId: "workspace-B",
      threadId: "thread-A",
    });

    expect(first.ok && first.data.tabs).toHaveLength(1);
    expect(second.ok && second.data.tabs).toHaveLength(1);
    expect(first.ok && second.ok && first.data.activeTabId).not.toBe(second.ok && second.data.activeTabId);
    expect(getSession(window as never).tabsByThread.has(previewTabScopeKey("workspace-A", "thread-A"))).toBe(true);
    expect(getSession(window as never).tabsByThread.has(previewTabScopeKey("workspace-B", "thread-A"))).toBe(true);
  });

  it("opens, activates, and closes tabs while preserving one fallback tab", async () => {
    const listed = invoke<{ activeTabId: string }>("preview:tabs.list", {
      workspaceId: "workspace-A",
      threadId: "thread-A",
    });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;

    const opened = await invokeAsync<{ tabId: string }>("preview:tabs.open", {
      workspaceId: "workspace-A",
      threadId: "thread-A",
      initialAddress: "https://example.test/page",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const activated = invoke<{ activeTabId: string }>("preview:tabs.activate", {
      workspaceId: "workspace-A",
      threadId: "thread-A",
      tabId: listed.data.activeTabId,
    });
    expect(activated).toMatchObject({ ok: true, data: { activeTabId: listed.data.activeTabId } });

    const closedFirst = invoke<{ activeTabId: string; tabs: unknown[] }>("preview:tabs.close", {
      workspaceId: "workspace-A",
      threadId: "thread-A",
      tabId: listed.data.activeTabId,
    });
    expect(closedFirst).toMatchObject({ ok: true, data: { activeTabId: opened.data.tabId } });

    const closedLast = invoke<{ activeTabId: string; tabs: unknown[] }>("preview:tabs.close", {
      workspaceId: "workspace-A",
      threadId: "thread-A",
      tabId: opened.data.tabId,
    });
    expect(closedLast.ok && closedLast.data.tabs).toHaveLength(1);
    expect(closedLast.ok && closedLast.data.activeTabId).toBeTruthy();
  });

  it("accepts a safe local file for the same navigation resolver as the address bar", async () => {
    const opened = await invokeAsync<{ tabs: { tabs: Array<{ url: string | null }> } }>("preview:tabs.open", {
      workspaceId: "workspace-A",
      threadId: "thread-A",
      initialAddress: SAFE_LOCAL_PAGE_URL,
    });

    expect(opened).toMatchObject({ ok: true });
    if (!opened.ok) return;
    expect(opened.data.tabs.tabs).toContainEqual(expect.objectContaining({ url: SAFE_LOCAL_PAGE_URL }));
  });

  it("persists a safe local file after the Browser surface reports its loaded URL", async () => {
    const listed = invoke<{ activeTabId: string }>("preview:tabs.list", {
      workspaceId: "workspace-A",
      threadId: "thread-A",
    });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;

    const updated = await invokeAsync<{ tabs: Array<{ id: string; url: string | null }> }>("preview:tabs.updateChrome", {
      workspaceId: "workspace-A",
      threadId: "thread-A",
      tabId: listed.data.activeTabId,
      title: "Local page",
      url: SAFE_LOCAL_PAGE_URL,
      faviconUrl: null,
    });

    expect(updated).toMatchObject({ ok: true });
    if (!updated.ok) return;
    expect(updated.data.tabs).toContainEqual(expect.objectContaining({
      id: listed.data.activeTabId,
      url: SAFE_LOCAL_PAGE_URL,
    }));
  });

  it("persists renderer-observed tab chrome across activation snapshots", async () => {
    const first = invoke<{ activeTabId: string }>("preview:tabs.list", {
      workspaceId: "workspace-A",
      threadId: "thread-A",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const opened = await invokeAsync<{ tabId: string }>("preview:tabs.open", {
      workspaceId: "workspace-A",
      threadId: "thread-A",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    expect(await invokeAsync("preview:tabs.updateChrome", {
      workspaceId: "workspace-A",
      threadId: "thread-A",
      tabId: opened.data.tabId,
      title: "Loaded page",
      url: "https://example.test/loaded",
      faviconUrl: "https://example.test/favicon.ico",
    })).toMatchObject({ ok: true });

    const activated = invoke<{ tabs: Array<Record<string, unknown>> }>("preview:tabs.activate", {
      workspaceId: "workspace-A",
      threadId: "thread-A",
      tabId: first.data.activeTabId,
    });
    expect(activated.ok && activated.data.tabs).toContainEqual(expect.objectContaining({
      id: opened.data.tabId,
      title: "Loaded page",
      url: "https://example.test/loaded",
      faviconUrl: "https://example.test/favicon.ico",
    }));
  });

  it("clears explicit null chrome fields while preserving omitted fields", async () => {
    const listed = invoke<{ activeTabId: string }>("preview:tabs.list", {
      workspaceId: "workspace-A",
      threadId: "thread-A",
    });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;

    expect(await invokeAsync("preview:tabs.updateChrome", {
      workspaceId: "workspace-A",
      threadId: "thread-A",
      tabId: listed.data.activeTabId,
      title: "Loaded page",
      url: "https://example.test/loaded",
      faviconUrl: "https://example.test/favicon.ico",
    })).toMatchObject({ ok: true });

    const updated = await invokeAsync<{ tabs: Array<Record<string, unknown>> }>("preview:tabs.updateChrome", {
      workspaceId: "workspace-A",
      threadId: "thread-A",
      tabId: listed.data.activeTabId,
      title: null,
    });
    expect(updated.ok && updated.data.tabs).toContainEqual(expect.objectContaining({
      id: listed.data.activeTabId,
      title: null,
      url: "https://example.test/loaded",
      faviconUrl: "https://example.test/favicon.ico",
    }));
  });

  it("rejects unsafe renderer-observed URLs and canonicalizes unloaded markers", async () => {
    const listed = invoke<{ activeTabId: string; tabs: Array<{ id: string; url: string | null }> }>(
      "preview:tabs.list",
      { workspaceId: "workspace-A", threadId: "thread-A" },
    );
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;

    for (const url of ["file:///sensitive.html", "data:text/html,unsafe"]) {
      expect(await invokeAsync("preview:tabs.updateChrome", {
        workspaceId: "workspace-A",
        threadId: "thread-A",
        tabId: listed.data.activeTabId,
        title: "Unsafe",
        url,
        faviconUrl: null,
      })).toEqual({ ok: false, error: "invalid-tab-chrome" });
    }

    expect(await invokeAsync("preview:tabs.updateChrome", {
      workspaceId: "workspace-A",
      threadId: "thread-A",
      tabId: listed.data.activeTabId,
      title: null,
      url: "about:blank",
      faviconUrl: null,
    })).toMatchObject({ ok: true });
    const refreshed = invoke<{ tabs: Array<{ id: string; url: string | null }> }>(
      "preview:tabs.list",
      { workspaceId: "workspace-A", threadId: "thread-A" },
    );
    expect(refreshed.ok && refreshed.data.tabs[0]?.url).toBeNull();
  });

  it("closes only the exact workspace-qualified scope", () => {
    invoke("preview:tabs.list", { workspaceId: "workspace-A", threadId: "thread-A" });
    invoke("preview:tabs.list", { workspaceId: "workspace-B", threadId: "thread-A" });

    expect(invoke("preview:tabs.closeScope", {
      workspaceId: "workspace-A",
      threadId: "thread-A",
    })).toEqual({ ok: true, data: { threadId: "thread-A", activeTabId: null, tabs: [] } });

    const session = getSession(window as never);
    expect(session.tabsByThread.has(previewTabScopeKey("workspace-A", "thread-A"))).toBe(false);
    expect(session.tabsByThread.has(previewTabScopeKey("workspace-B", "thread-A"))).toBe(true);
  });

  it("rejects hostile senders and invalid identifiers or initial addresses", async () => {
    expect(ipcHandlers["preview:tabs.list"]!({ sender: {} }, {
      workspaceId: "workspace-A",
      threadId: "thread-A",
    })).toEqual({ ok: false, error: "no-window" });
    expect(invoke("preview:tabs.list", { workspaceId: "", threadId: "thread-A" })).toEqual({
      ok: false,
      error: "invalid-workspace-id",
    });
    expect(await invokeAsync("preview:tabs.open", {
      workspaceId: "workspace-A",
      threadId: "thread-A",
      initialAddress: "https://user:password@example.test",
    })).toEqual({ ok: false, error: "invalid-initial-address" });
    expect(await invokeAsync("preview:tabs.open", {
      workspaceId: "workspace-A",
      threadId: "thread-A",
      initialAddress: "file:///sensitive.html",
    })).toEqual({ ok: false, error: "invalid-initial-address" });
    expect(await invokeAsync("preview:tabs.updateChrome", {
      workspaceId: "workspace-A",
      threadId: "thread-A",
      tabId: "tab-A",
      title: {},
      url: null,
      faviconUrl: null,
    })).toEqual({ ok: false, error: "invalid-tab-chrome" });
  });

  it("does not change workspace context when open or chrome validation fails", async () => {
    const session = getSession(window as never);
    session.workspaceId = "workspace-existing";

    expect(await invokeAsync("preview:tabs.open", {
      workspaceId: "workspace-untrusted",
      threadId: "thread-A",
      initialAddress: "file:///sensitive.html",
    })).toEqual({ ok: false, error: "invalid-initial-address" });
    expect(session.workspaceId).toBe("workspace-existing");

    expect(await invokeAsync("preview:tabs.updateChrome", {
      workspaceId: "workspace-untrusted",
      threadId: "thread-A",
      tabId: "tab-A",
      title: {},
      url: null,
      faviconUrl: null,
    })).toEqual({ ok: false, error: "invalid-tab-chrome" });
    expect(session.workspaceId).toBe("workspace-existing");
  });
});
