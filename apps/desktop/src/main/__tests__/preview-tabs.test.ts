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

import { registerTabHandlers } from "../preview/preview-tabs.js";
import { getSession, previewTabScopeKey, sessions } from "../preview/preview-session.js";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

function invoke<T>(channel: string, payload: Record<string, unknown>): Result<T> {
  return ipcHandlers[channel]!({ sender: window.webContents }, payload) as Result<T>;
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

  it("opens, activates, and closes tabs while preserving one fallback tab", () => {
    const listed = invoke<{ activeTabId: string }>("preview:tabs.list", {
      workspaceId: "workspace-A",
      threadId: "thread-A",
    });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;

    const opened = invoke<{ tabId: string }>("preview:tabs.open", {
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

  it("rejects hostile senders and invalid identifiers or initial addresses", () => {
    expect(ipcHandlers["preview:tabs.list"]!({ sender: {} }, {
      workspaceId: "workspace-A",
      threadId: "thread-A",
    })).toEqual({ ok: false, error: "no-window" });
    expect(invoke("preview:tabs.list", { workspaceId: "", threadId: "thread-A" })).toEqual({
      ok: false,
      error: "invalid-workspace-id",
    });
    expect(invoke("preview:tabs.open", {
      workspaceId: "workspace-A",
      threadId: "thread-A",
      initialAddress: "https://user:password@example.test",
    })).toEqual({ ok: false, error: "invalid-initial-address" });
    expect(invoke("preview:tabs.open", {
      workspaceId: "workspace-A",
      threadId: "thread-A",
      initialAddress: "file:///sensitive.html",
    })).toEqual({ ok: false, error: "invalid-initial-address" });
  });
});
