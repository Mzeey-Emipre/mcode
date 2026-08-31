import * as NodeEvents from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  recordTrustedPreviewClipboardClick,
  registerPreviewClipboardGuest,
  registerPreviewClipboardPermissionHandlers,
} from "../clipboard-trust.js";

type PermissionCheckHandler = (
  webContents: FakeWebContents | null,
  permission: string,
  requestingOrigin: string,
  details: { isMainFrame: boolean; requestingUrl?: string },
) => boolean;

type PermissionRequestHandler = (
  webContents: FakeWebContents,
  permission: string,
  callback: (granted: boolean) => void,
  details: { isMainFrame: boolean; requestingUrl: string },
) => void;

class FakeWebContents extends NodeEvents.EventEmitter {
  public destroyed = false;
  public url = "https://example.test/page";
  public readonly mainFrame = {};

  public constructor(public readonly id: number) {
    super();
  }

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public getURL(): string {
    return this.url;
  }
}

describe("Preview clipboard trust", () => {
  let checkHandler: PermissionCheckHandler;
  let requestHandler: PermissionRequestHandler;
  let guest: FakeWebContents;
  let current: boolean;
  let disposeGuest: () => void;
  let trustIpcHandler: (event: {
    sender: FakeWebContents;
    senderFrame: unknown;
  }) => void;

  beforeEach(() => {
    const session = {
      setPermissionCheckHandler(handler: PermissionCheckHandler) {
        checkHandler = handler;
      },
      setPermissionRequestHandler(handler: PermissionRequestHandler) {
        requestHandler = handler;
      },
    };
    const ipc = {
      on(_channel: string, handler: typeof trustIpcHandler) {
        trustIpcHandler = handler;
      },
    };
    registerPreviewClipboardPermissionHandlers(session as never, ipc as never);
    guest = new FakeWebContents(1);
    current = true;
    disposeGuest = registerPreviewClipboardGuest(guest as never, () => current);
  });

  afterEach(() => {
    disposeGuest();
    vi.useRealTimers();
  });

  function click(): void {
    recordTrustedPreviewClipboardClick(guest as never);
  }

  function request(
    permission = "clipboard-sanitized-write",
    details = { isMainFrame: true, requestingUrl: guest.url },
  ): boolean {
    const callback = vi.fn();
    requestHandler(guest, permission, callback, details);
    expect(callback).toHaveBeenCalledOnce();
    return callback.mock.calls[0]![0] as boolean;
  }

  function check(
    permission = "clipboard-sanitized-write",
    requestingOrigin = "https://example.test",
    details: { isMainFrame: boolean; requestingUrl?: string } = { isMainFrame: true },
  ): boolean {
    return checkHandler(guest, permission, requestingOrigin, details);
  }

  it("permits one sanitized write through the request handler after a trusted click", () => {
    click();

    expect(request()).toBe(true);
    expect(request()).toBe(false);
  });

  it("applies the same one-shot rule through the permission check handler", () => {
    click();

    expect(check()).toBe(true);
    expect(check()).toBe(false);
  });

  it("denies reads, subframes, mismatched documents, and missing trusted input", () => {
    expect(request()).toBe(false);

    click();
    expect(request("clipboard-read")).toBe(false);

    click();
    expect(request("clipboard-sanitized-write", {
      isMainFrame: false,
      requestingUrl: guest.url,
    })).toBe(false);

    click();
    expect(request("clipboard-sanitized-write", {
      isMainFrame: true,
      requestingUrl: "https://example.test/other",
    })).toBe(false);

    click();
    expect(check("clipboard-sanitized-write", "https://other.test")).toBe(false);
  });

  it("accepts only the registered main-frame preload signal on a current surface", () => {
    trustIpcHandler({ sender: guest, senderFrame: {} });
    expect(request()).toBe(false);

    trustIpcHandler({ sender: guest, senderFrame: guest.mainFrame });
    expect(request()).toBe(true);

    current = false;
    click();
    current = true;
    expect(request()).toBe(false);
  });

  it("revokes trust after a main-frame document change or timeout", () => {
    click();
    guest.emit("did-start-navigation", {}, "https://example.test/next", false, true);
    guest.url = "https://example.test/next";
    expect(request("clipboard-sanitized-write", {
      isMainFrame: true,
      requestingUrl: guest.url,
    })).toBe(false);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T12:00:00Z"));
    click();
    vi.advanceTimersByTime(5_001);
    expect(request("clipboard-sanitized-write", {
      isMainFrame: true,
      requestingUrl: guest.url,
    })).toBe(false);
  });

  it("rejects a stale guest generation after replacement", () => {
    click();
    const replacement = new FakeWebContents(guest.id);
    const disposeReplacement = registerPreviewClipboardGuest(replacement as never, () => true);

    expect(request()).toBe(false);

    const callback = vi.fn();
    recordTrustedPreviewClipboardClick(replacement as never);
    requestHandler(
      replacement,
      "clipboard-sanitized-write",
      callback,
      { isMainFrame: true, requestingUrl: replacement.url },
    );
    expect(callback).toHaveBeenCalledWith(true);
    disposeReplacement();
  });
});
