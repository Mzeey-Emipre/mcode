import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  findAdoptedWebContentsForWindow,
  requestRendererSurfaceDiscard,
} = vi.hoisted(() => ({
  findAdoptedWebContentsForWindow: vi.fn(() => null),
  requestRendererSurfaceDiscard: vi.fn(() => true),
}));

vi.mock("electron", () => ({ BrowserWindow: class {} }));
vi.mock("@mcode/shared", () => ({
  getMcodeDir: () => "Z:\\missing-mcode-test-dir",
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../surfaces/registry.js", () => ({
  findAdoptedWebContentsForWindow,
  requestRendererSurfaceDiscard,
}));
vi.mock("../../navigation/local-file.js", () => ({
  validateResumeUrl: vi.fn(async (url: string | null) => url),
}));
vi.mock("../../navigation/policy.js", () => ({
  isAllowedPreviewUrl: vi.fn(() => true),
}));

import {
  clearDiscardTimers,
  onPreviewHidden,
  onPreviewVisible,
  runDiscardSweep,
} from "../discard-scheduler.js";
import {
  getSession,
  previewTabScopeKey,
  sessions,
  type PreviewSession,
} from "../../state/window-session.js";

const window = {
  id: 7,
  isDestroyed: () => false,
  webContents: { isDestroyed: () => false, send: vi.fn() },
};

function session(): PreviewSession {
  const current = getSession(window as never);
  current.workspaceId = "workspace-A";
  current.lastPreviewThreadId = "thread-A";
  return current;
}

beforeEach(() => {
  vi.useFakeTimers();
  requestRendererSurfaceDiscard.mockClear();
  findAdoptedWebContentsForWindow.mockClear();
  sessions.clear();
});

afterEach(() => {
  const current = sessions.get(window.id);
  if (current) clearDiscardTimers(current);
  sessions.clear();
  vi.useRealTimers();
});

describe("Preview Memory Saver scheduler", () => {
  it("cancels a hidden discard when Preview becomes visible again", () => {
    const current = session();

    onPreviewVisible(window as never, current);
    expect(current.discardSweepTimer).not.toBeNull();

    onPreviewHidden(window as never, current);
    expect(current.discardSweepTimer).toBeNull();
    expect(current.discardHiddenTimer).not.toBeNull();

    onPreviewVisible(window as never, current);
    expect(current.discardHiddenTimer).toBeNull();
    expect(current.discardSweepTimer).not.toBeNull();
  });

  it("requests deterministic exact-tab discards without destroying guests", async () => {
    const current = session();
    current.tabsByThread.set(previewTabScopeKey("workspace-A", "thread-A"), {
      threadId: "thread-A",
      activeTabId: "tab-newest",
      tabs: [
        { id: "tab-newest", threadId: "thread-A", resumeUrl: null, title: null, faviconUrl: null, lastActiveAt: 400, rendererSurfaceGeneration: 4 },
        { id: "tab-second", threadId: "thread-A", resumeUrl: null, title: null, faviconUrl: null, lastActiveAt: 300, rendererSurfaceGeneration: 3 },
        { id: "tab-oldest", threadId: "thread-A", resumeUrl: null, title: null, faviconUrl: null, lastActiveAt: 100, rendererSurfaceGeneration: 1 },
        { id: "tab-older", threadId: "thread-A", resumeUrl: null, title: null, faviconUrl: null, lastActiveAt: 200, rendererSurfaceGeneration: 2 },
      ],
    });

    vi.setSystemTime(100_000);
    await runDiscardSweep(window as never, current, false, {
      maxWarm: 2,
      bgIdleMs: 30_000,
      hiddenIdleMs: 1_000,
    });

    expect(requestRendererSurfaceDiscard.mock.calls).toEqual([
      [window, "workspace-A", "thread-A", "tab-older"],
      [window, "workspace-A", "thread-A", "tab-oldest"],
    ]);
    expect(current.discardSweepInProgress).toBe(false);
  });
});
