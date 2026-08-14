import { beforeEach, describe, expect, it, vi } from "vitest";
import { previewTabScopeKey, sessions, type PreviewSession } from "../../state/window-session.js";

const findAdoptedWebContentsForWindow = vi.hoisted(() => vi.fn());

vi.mock("../registry.js", () => ({ findAdoptedWebContentsForWindow }));

import { resolveActivePreviewWebContents } from "../active-web-contents.js";

describe("active Preview guest resolution", () => {
  beforeEach(() => {
    sessions.clear();
    findAdoptedWebContentsForWindow.mockReset();
  });

  it("returns only the adopted guest for the active tab", () => {
    const activeGuest = { isDestroyed: () => false };
    const inactiveGuest = { isDestroyed: () => false };
    findAdoptedWebContentsForWindow.mockImplementation(
      (_windowId: number, _threadId: string, tabId: string) =>
        tabId === "tab-active" ? activeGuest : inactiveGuest,
    );
    const session = {
      workspaceId: "workspace-A",
      lastPreviewThreadId: "thread-A",
      tabsByThread: new Map([
        [
          previewTabScopeKey("workspace-A", "thread-A"),
          {
            threadId: "thread-A",
            activeTabId: "tab-active",
            tabs: [
              { id: "tab-active", threadId: "thread-A" },
              { id: "tab-inactive", threadId: "thread-A" },
            ],
          },
        ],
      ]),
    } as unknown as PreviewSession;
    sessions.set(11, session);

    expect(resolveActivePreviewWebContents(session)).toBe(activeGuest);
    expect(findAdoptedWebContentsForWindow).toHaveBeenCalledWith(11, "thread-A", "tab-active");
  });

  it("returns no guest when the Preview thread is not active", () => {
    const session = { lastPreviewThreadId: null } as unknown as PreviewSession;

    expect(resolveActivePreviewWebContents(session)).toBeNull();
    expect(findAdoptedWebContentsForWindow).not.toHaveBeenCalled();
  });
});
