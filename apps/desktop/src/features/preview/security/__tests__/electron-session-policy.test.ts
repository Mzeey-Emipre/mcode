import { describe, expect, it, vi } from "vitest";

const previewSession = {
  on: vi.fn(),
  clearStorageData: vi.fn(async () => undefined),
  clearCache: vi.fn(async () => undefined),
};

vi.mock("electron", () => ({
  ipcMain: { on: vi.fn() },
  session: {
    fromPartition: vi.fn((partition: string) => {
      if (partition !== "persist:mcode-preview") throw new Error(`unexpected partition ${partition}`);
      return previewSession;
    }),
  },
}));

vi.mock("../clipboard-trust.js", () => ({
  registerPreviewClipboardPermissionHandlers: vi.fn(),
}));

import { session } from "electron";
import { PreviewSessionAdapter } from "../electron-session-policy.js";

describe("PreviewSessionAdapter", () => {
  const surface = {
    sourceSurface: {
      identity: {
        workspaceId: "workspace",
        scope: { kind: "thread" as const, id: "thread" },
        tabId: "tab",
      },
      generation: 1,
    },
  };

  it("uses one fixed partition and denies guest popup creation", () => {
    const adapter = new PreviewSessionAdapter();
    const guest = {
      setWindowOpenHandler: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
      isDestroyed: () => false,
    };

    expect(adapter.session).toBe(previewSession);
    expect(session.fromPartition).toHaveBeenCalledWith("persist:mcode-preview");

    adapter.bindGuestPopup(guest as never, {
      ...surface,
      emitPopup: vi.fn(),
      isAgentOperationActive: () => false,
    });

    const handler = guest.setWindowOpenHandler.mock.calls[0]?.[0] as ((details: { url: string }) => unknown) | undefined;
    expect(handler?.({ url: "https://example.test" })).toEqual({ action: "deny" });
  });

  it("owns cookies, cache, clipboard policy, and denied downloads", async () => {
    const adapter = new PreviewSessionAdapter({ previewSession: previewSession as never });
    adapter.registerPolicy();
    adapter.registerPolicy();
    expect(previewSession.on).toHaveBeenCalledTimes(1);
    const downloadEvent = { preventDefault: vi.fn() };
    const downloadHandler = previewSession.on.mock.calls[0]?.[1] as ((event: typeof downloadEvent) => void);
    downloadHandler(downloadEvent);
    expect(downloadEvent.preventDefault).toHaveBeenCalledTimes(1);
    await adapter.clearCookies();
    await adapter.clearCache();
    expect(previewSession.clearStorageData).toHaveBeenCalledWith({ storages: ["cookies"] });
    expect(previewSession.clearCache).toHaveBeenCalledTimes(1);
  });

  it("emits only bounded credential-free HTTP(S) popups and unbinds stale guests", () => {
    let destroyed: (() => void) | undefined;
    const setWindowOpenHandler = vi.fn();
    const guest = {
      setWindowOpenHandler,
      once: vi.fn((_event: string, listener: () => void) => { destroyed = listener; }),
      removeListener: vi.fn(),
      isDestroyed: () => false,
    };
    const emitPopup = vi.fn();
    let agent = false;
    const adapter = new PreviewSessionAdapter({ previewSession: previewSession as never });
    const unbind = adapter.bindGuestPopup(guest as never, {
      ...surface,
      emitPopup,
      isAgentOperationActive: () => agent,
    });
    const handler = setWindowOpenHandler.mock.calls[0]?.[0] as ((details: { url: string }) => unknown);
    for (const address of ["file:///tmp/x", "javascript:alert(1)", "data:text/html,hello", "custom:test", "https://user:pass@example.test", "not a url", `https://example.test/${"x".repeat(4096)}`]) {
      expect(handler({ url: address })).toEqual({ action: "deny" });
    }
    expect(emitPopup).not.toHaveBeenCalled();
    agent = true;
    expect(handler({ url: "https://example.test/agent" })).toEqual({ action: "deny" });
    expect(emitPopup).toHaveBeenCalledWith({ ...surface, address: "https://example.test/agent", initiator: "agent" });
    agent = false;
    expect(handler({ url: "http://example.test/human" })).toEqual({ action: "deny" });
    expect(emitPopup).toHaveBeenLastCalledWith({ ...surface, address: "http://example.test/human", initiator: "human" });
    emitPopup.mockImplementationOnce(() => { throw new Error("renderer unavailable"); });
    expect(handler({ url: "https://example.test/delivery-failure" })).toEqual({ action: "deny" });
    destroyed?.();
    expect(handler({ url: "https://example.test/stale" })).toEqual({ action: "deny" });
    expect(emitPopup).toHaveBeenCalledTimes(3);
    unbind();
    expect(setWindowOpenHandler).toHaveBeenLastCalledWith(expect.any(Function));
  });
});
