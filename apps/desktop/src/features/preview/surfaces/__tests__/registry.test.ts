import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolvePreviewGuestPreloadPath } from "../../security/webview-attachment-policy.js";

const ipcHandlers: Record<string, (...args: unknown[]) => unknown> = {};
const fakeGuests: FakeWebContents[] = [];
const previewPartition = {};
const allWindows: FakeWindow[] = [];
const fixedPreload = resolvePreviewGuestPreloadPath(
  dirname(fileURLToPath(import.meta.url)),
);

interface FakeWindow {
  id: number;
  isDestroyed: () => boolean;
  isFocused: () => boolean;
  webContents: { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> };
}

interface FakeWebContents {
  destroyed: boolean;
  url: string;
  title: string;
  hostWebContents: unknown;
  session: object;
  getType: () => string;
  getURL: () => string;
  getLastWebPreferences: () => { preload: string };
  isDestroyed: () => boolean;
  setWindowOpenHandler: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  canGoBack: ReturnType<typeof vi.fn>;
  canGoForward: ReturnType<typeof vi.fn>;
  goBack: ReturnType<typeof vi.fn>;
  goForward: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  reloadIgnoringCache: ReturnType<typeof vi.fn>;
  once: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener: (event: string, listener: (...args: unknown[]) => void) => void;
  emit: (event: string, ...args: unknown[]) => void;
}

function makeWindow(id: number): FakeWindow {
  return {
    id,
    isDestroyed: () => false,
    isFocused: () => true,
    webContents: { isDestroyed: () => false, send: vi.fn() },
  };
}

function makeGuest(
  host: FakeWindow,
  overrides: Partial<Pick<FakeWebContents, "getType" | "hostWebContents" | "session">> = {},
): FakeWebContents {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const guest: FakeWebContents = {
    destroyed: false,
    url: "about:blank#token-1234",
    title: "Preview",
    hostWebContents: overrides.hostWebContents ?? host.webContents,
    session: overrides.session ?? previewPartition,
    getType: overrides.getType ?? (() => "webview"),
    getURL() { return this.url; },
    getLastWebPreferences() { return { preload: fixedPreload }; },
    isDestroyed() { return this.destroyed; },
    setWindowOpenHandler: vi.fn(),
    loadURL: vi.fn(async (url: string) => { guest.url = url; }),
    canGoBack: vi.fn(() => true),
    canGoForward: vi.fn(() => true),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
    once(event, listener) {
      const bag = listeners.get(event) ?? new Set();
      listeners.set(event, bag);
      bag.add(listener);
    },
    removeListener(event, listener) { listeners.get(event)?.delete(listener); },
    emit(event, ...args) { for (const listener of [...(listeners.get(event) ?? [])]) listener(...args); },
  };
  fakeGuests.push(guest);
  return guest;
}

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents: vi.fn((sender: unknown) => allWindows.find((window) => window.webContents === sender) ?? null),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => { ipcHandlers[channel] = handler; }),
  },
  session: {
    fromPartition: vi.fn((partition: string) => partition === "persist:mcode-preview" ? previewPartition : {}),
  },
  webContents: {
    getAllWebContents: vi.fn(() => fakeGuests),
  },
}));

vi.mock("@mcode/shared", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../../security/clipboard-trust.js", () => ({
  registerPreviewClipboardGuest: vi.fn(),
  unregisterPreviewClipboardGuest: vi.fn(),
}));

import {
  _resetAdoptionRegistryForTests,
  findAdoptedWebContentsForWindow,
  registerPreviewSurfaceHandlers,
  requestRendererSurfaceDiscard,
} from "../registry.js";
import { getSession, previewTabScopeKey, sessions, toBrowserTabSet } from "../../state/window-session.js";

const surface = (generation = 1) => ({
  identity: {
    workspaceId: "workspace-A",
    scope: { kind: "thread" as const, id: "thread-A" },
    tabId: "tab-1",
  },
  generation,
});

function invoke(channel: string, payload: unknown, sender = allWindows[0]!.webContents): unknown {
  return ipcHandlers[channel]!({ sender } as unknown, payload);
}

beforeEach(() => {
  fakeGuests.length = 0;
  allWindows.length = 0;
  allWindows.push(makeWindow(1));
  const session = getSession(allWindows[0] as never);
  session.workspaceId = "workspace-A";
  session.tabsByThread.clear();
  session.tabsByThread.set(previewTabScopeKey("workspace-A", "thread-A"), {
    threadId: "thread-A",
    activeTabId: "tab-1",
    tabs: [{ id: "tab-1", threadId: "thread-A", resumeUrl: null, title: null, faviconUrl: null, lastActiveAt: 0 }],
  });
  _resetAdoptionRegistryForTests();
  registerPreviewSurfaceHandlers();
});

afterEach(() => {
  _resetAdoptionRegistryForTests();
  sessions.clear();
});

describe("preview typed surface bridge", () => {
  it("requires prepare, adopts the unique inert owned guest, and resolves exact generation", () => {
    const guest = makeGuest(allWindows[0]!);
    expect(invoke("preview.surface.prepare", { surface: surface(), adoptionToken: "token-1234" })).toEqual({ ok: true });
    expect(invoke("preview.surface.adopt", { surface: surface(), adoptionToken: "token-1234" })).toEqual({ ok: true });
    expect(findAdoptedWebContentsForWindow(1, "thread-A", "tab-1", 1)).toBe(guest);
    expect(findAdoptedWebContentsForWindow(1, "thread-A", "tab-1", 2)).toBeNull();
    expect(toBrowserTabSet(getSession(allWindows[0] as never), "thread-A").tabs[0]?.warm).toBe(true);
  });

  it("rejects hostile sender, incomplete identity, mismatched owner, type, partition, and non-blank guests", () => {
    const hostile = makeWindow(2);
    expect(invoke("preview.surface.prepare", { surface: surface(), adoptionToken: "token-1234" }, hostile.webContents)).toMatchObject({ ok: false, error: "no-window" });
    expect(invoke("preview.surface.prepare", { surface: { generation: 1 }, adoptionToken: "token-1234" })).toMatchObject({ ok: false, error: "invalid-surface" });
    expect(invoke("preview.surface.prepare", { surface: { ...surface(), identity: { ...surface().identity, workspaceId: "workspace-other" } }, adoptionToken: "token-1234" })).toMatchObject({ ok: false, error: "surface-owner-mismatch" });
    expect(invoke("preview.surface.prepare", { surface: { ...surface(), identity: { ...surface().identity, scope: { kind: "thread", id: "thread-other" } } }, adoptionToken: "token-1234" })).toMatchObject({ ok: false, error: "surface-owner-mismatch" });
    for (const overrides of [
      { getType: () => "window" },
      { hostWebContents: hostile.webContents },
      { session: {} },
    ]) {
      _resetAdoptionRegistryForTests();
      const guest = makeGuest(allWindows[0]!, overrides);
      expect(invoke("preview.surface.prepare", { surface: surface(), adoptionToken: "token-1234" })).toEqual({ ok: true });
      expect(invoke("preview.surface.adopt", { surface: surface(), adoptionToken: "token-1234" })).toMatchObject({ ok: false });
      guest.url = "about:blank#token-1234";
    }
  });

  it("fails closed for stale, duplicate, non-unique, and post-blank adoption", () => {
    const guest = makeGuest(allWindows[0]!);
    guest.url = "about:blank";
    expect(invoke("preview.surface.prepare", { surface: surface(), adoptionToken: "token-1234" })).toEqual({ ok: true });
    expect(invoke("preview.surface.adopt", { surface: surface(), adoptionToken: "token-1234" })).toMatchObject({ ok: false, error: "guest-not-found" });
    guest.url = "about:blank#token-1234";
    expect(invoke("preview.surface.adopt", { surface: surface(2), adoptionToken: "token-1234" })).toMatchObject({ ok: false, error: "stale-generation" });
    expect(invoke("preview.surface.prepare", { surface: surface(), adoptionToken: "token-1234" })).toMatchObject({ ok: false, error: "duplicate-adoption" });
    _resetAdoptionRegistryForTests();
    fakeGuests.length = 0;
    makeGuest(allWindows[0]!);
    makeGuest(allWindows[0]!);
    expect(invoke("preview.surface.prepare", { surface: surface(), adoptionToken: "token-1234" })).toEqual({ ok: true });
    expect(invoke("preview.surface.adopt", { surface: surface(), adoptionToken: "token-1234" })).toMatchObject({ ok: false, error: "non-unique-adoption" });
  });

  it("returns the next valid generation when renderer state restarts after reload", () => {
    expect(invoke("preview.surface.prepare", { surface: surface(7), adoptionToken: "token-1234" })).toEqual({ ok: true });

    expect(invoke("preview.surface.prepare", { surface: surface(1), adoptionToken: "token-5678" })).toEqual({
      ok: false,
      error: "stale-generation",
      nextGeneration: 8,
    });
  });

  it("retires the adopted guest when the owner advances to a new generation", () => {
    const firstGuest = makeGuest(allWindows[0]!);
    expect(invoke("preview.surface.prepare", { surface: surface(), adoptionToken: "token-1234" })).toEqual({ ok: true });
    expect(invoke("preview.surface.adopt", { surface: surface(), adoptionToken: "token-1234" })).toEqual({ ok: true });

    firstGuest.url = "https://example.test";
    const secondGuest = makeGuest(allWindows[0]!);
    secondGuest.url = "about:blank#token-5678";
    expect(invoke("preview.surface.prepare", { surface: surface(2), adoptionToken: "token-5678" })).toEqual({ ok: true });
    expect(findAdoptedWebContentsForWindow(1, "thread-A", "tab-1", 1)).toBeNull();
    expect(invoke("preview.surface.adopt", { surface: surface(2), adoptionToken: "token-5678" })).toEqual({ ok: true });
    expect(findAdoptedWebContentsForWindow(1, "thread-A", "tab-1", 2)).toBe(secondGuest);

    const tabSet = getSession(allWindows[0] as never).tabsByThread.get(
      previewTabScopeKey("workspace-A", "thread-A"),
    )!;
    tabSet.tabs.push({ ...tabSet.tabs[0]!, id: "tab-2" });
    const otherSurface = { ...surface(), identity: { ...surface().identity, tabId: "tab-2" } };
    expect(invoke("preview.surface.prepare", { surface: otherSurface, adoptionToken: "token-5678" })).toMatchObject({ ok: false, error: "duplicate-adoption-token" });
  });

  it("releases the exact adopted generation after its tab ownership record is removed", () => {
    makeGuest(allWindows[0]!);
    expect(invoke("preview.surface.prepare", { surface: surface(), adoptionToken: "token-1234" })).toEqual({ ok: true });
    expect(invoke("preview.surface.adopt", { surface: surface(), adoptionToken: "token-1234" })).toEqual({ ok: true });
    getSession(allWindows[0] as never).tabsByThread.clear();

    expect(invoke("preview.surface.release", {
      surface: surface(),
      reason: "dispose",
    })).toEqual({ ok: true });
    expect(findAdoptedWebContentsForWindow(1, "thread-A", "tab-1", 1)).toBeNull();
  });

  it("marks renderer residency cold on release and requests policy-selected discard by exact generation", () => {
    makeGuest(allWindows[0]!);
    expect(invoke("preview.surface.prepare", { surface: surface(), adoptionToken: "token-1234" })).toEqual({ ok: true });
    expect(invoke("preview.surface.adopt", { surface: surface(), adoptionToken: "token-1234" })).toEqual({ ok: true });

    expect(requestRendererSurfaceDiscard(allWindows[0] as never, "workspace-other", "thread-A", "tab-1")).toBe(false);
    expect(requestRendererSurfaceDiscard(allWindows[0] as never, "workspace-A", "thread-A", "tab-1")).toBe(true);
    expect(allWindows[0]!.webContents.send).toHaveBeenCalledWith(
      "preview.surface.discard-requested",
      surface(),
    );
    expect(invoke("preview.surface.release", {
      surface: surface(),
      reason: "attacker-controlled",
    })).toMatchObject({ ok: false, error: "invalid-release-reason" });

    expect(invoke("preview.surface.release", {
      surface: surface(),
      reason: "discard",
    })).toEqual({ ok: true });
    expect(toBrowserTabSet(getSession(allWindows[0] as never), "thread-A").tabs[0]?.warm).toBe(false);
    expect(allWindows[0]!.webContents.send).toHaveBeenCalledWith(
      "preview:tabs-updated",
      expect.objectContaining({
        tabs: [expect.objectContaining({ id: "tab-1", warm: false })],
      }),
    );
  });

  it("revalidates exact generation for address, history, reload, and force reload", async () => {
    const guest = makeGuest(allWindows[0]!);
    expect(invoke("preview.surface.prepare", { surface: surface(), adoptionToken: "token-1234" })).toEqual({ ok: true });
    expect(invoke("preview.surface.adopt", { surface: surface(), adoptionToken: "token-1234" })).toEqual({ ok: true });
    expect(await invoke("preview.surface.navigate", { surface: surface(), navigation: { kind: "initial", address: "https://example.test" } })).toEqual({ ok: true });
    expect(await invoke("preview.surface.navigate", { surface: surface(), navigation: { kind: "address", address: "file://attacker/share" } })).toMatchObject({ ok: false, error: "sensitive-file" });
    const localUrl = pathToFileURL(fileURLToPath(import.meta.url)).href;
    expect(await invoke("preview.surface.navigate", { surface: surface(), navigation: { kind: "restored", address: localUrl } })).toEqual({ ok: true });
    expect(await invoke("preview.surface.navigate", { surface: surface(), navigation: { kind: "back" } })).toEqual({ ok: true });
    expect(await invoke("preview.surface.navigate", { surface: surface(), navigation: { kind: "forward" } })).toEqual({ ok: true });
    expect(await invoke("preview.surface.navigate", { surface: surface(), navigation: { kind: "reload" } })).toEqual({ ok: true });
    expect(await invoke("preview.surface.navigate", { surface: surface(), navigation: { kind: "force-reload" } })).toEqual({ ok: true });
    expect(guest.loadURL).toHaveBeenCalledWith("https://example.test");
    expect(guest.loadURL).toHaveBeenCalledWith(localUrl);
    expect(guest.reloadIgnoringCache).toHaveBeenCalledTimes(1);
    expect(await invoke("preview.surface.navigate", { surface: surface(2), navigation: { kind: "reload" } })).toMatchObject({ ok: false, error: "stale-generation" });
  });

  it("accepts an aborted address load after the guest commits a new URL", async () => {
    const guest = makeGuest(allWindows[0]!);
    expect(invoke("preview.surface.prepare", { surface: surface(), adoptionToken: "token-1234" })).toEqual({ ok: true });
    expect(invoke("preview.surface.adopt", { surface: surface(), adoptionToken: "token-1234" })).toEqual({ ok: true });
    guest.loadURL.mockImplementationOnce(async () => {
      guest.url = "https://example.test/final";
      throw Object.assign(new Error("ERR_ABORTED (-3)"), {
        code: "ERR_ABORTED",
        errno: -3,
      });
    });

    await expect(invoke("preview.surface.navigate", {
      surface: surface(),
      navigation: { kind: "address", address: "https://example.test/redirect" },
    })).resolves.toEqual({ ok: true });
  });

  it("preserves the Electron error code when an address load fails", async () => {
    const guest = makeGuest(allWindows[0]!);
    expect(invoke("preview.surface.prepare", { surface: surface(), adoptionToken: "token-1234" })).toEqual({ ok: true });
    expect(invoke("preview.surface.adopt", { surface: surface(), adoptionToken: "token-1234" })).toEqual({ ok: true });
    guest.loadURL.mockRejectedValueOnce(Object.assign(new Error("ERR_NAME_NOT_RESOLVED (-105)"), {
      code: "ERR_NAME_NOT_RESOLVED",
      errno: -105,
    }));

    await expect(invoke("preview.surface.navigate", {
      surface: surface(),
      navigation: { kind: "address", address: "https://missing.example.test" },
    })).resolves.toEqual({
      ok: false,
      error: "navigation-failed",
      errorCode: "ERR_NAME_NOT_RESOLVED",
    });
  });
});
