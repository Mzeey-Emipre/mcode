import { afterEach, describe, expect, it } from "vitest";

import {
  ensureThreadTabSet,
  getActiveTab,
  getSession,
  previewTabScopeKey,
  sessions,
  toBrowserTabSet,
} from "../window-session.js";

const windowA = { id: 101 } as never;

afterEach(() => {
  sessions.clear();
});

describe("Preview window session", () => {
  it("retains workspace, thread, tab, loading, and capture state for one window", () => {
    const session = getSession(windowA);
    session.workspaceId = "workspace-A";
    session.lastPreviewThreadId = "thread-A";
    session.resumePreviewUrl = "https://example.test/loaded";
    session.pageStatus = {
      url: session.resumePreviewUrl,
      title: "Loaded page",
      favicon: "https://example.test/favicon.ico",
      phase: "loading",
    };
    session.consoleBuffer.push("log: captured");
    session.failedRequestBuffer.push({
      url: "https://example.test/app.js",
      statusCode: 503,
      resourceType: "script",
    });

    const tabSet = ensureThreadTabSet(session, "thread-A");
    const tab = getActiveTab(session, "thread-A");
    tab.resumeUrl = session.resumePreviewUrl;
    tab.title = "Loaded page";
    tab.faviconUrl = "https://example.test/favicon.ico";

    expect(getSession(windowA)).toBe(session);
    expect(session.tabsByThread.get(previewTabScopeKey("workspace-A", "thread-A"))).toBe(tabSet);
    expect(toBrowserTabSet(session, "thread-A")).toMatchObject({
      threadId: "thread-A",
      activeTabId: tab.id,
      tabs: [{ id: tab.id, url: session.resumePreviewUrl, title: "Loaded page", active: true }],
    });
    expect(session.pageStatus.phase).toBe("loading");
    expect(session.consoleBuffer).toEqual(["log: captured"]);
    expect(session.failedRequestBuffer).toEqual([
      { url: "https://example.test/app.js", statusCode: 503, resourceType: "script" },
    ]);
  });
});
