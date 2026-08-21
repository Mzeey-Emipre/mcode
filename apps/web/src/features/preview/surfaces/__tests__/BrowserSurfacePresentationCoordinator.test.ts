import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserSurfaceHost, BrowserSurfaceIdentity, BrowserSurfacePageState } from "../../browser-surfaces";
import {
  BrowserSurfacePresentationCoordinator,
  type BrowserSurfacePresentationRect,
} from "../BrowserSurfacePresentationCoordinator";

const identity: BrowserSurfaceIdentity = {
  workspaceId: "workspace-1",
  scope: { kind: "thread", id: "thread-1" },
  tabId: "tab-1",
};

const panelRect: BrowserSurfacePresentationRect = {
  left: 10,
  top: 20,
  width: 640,
  height: 480,
};

function page(address = "https://example.test"): BrowserSurfacePageState {
  return {
    identity,
    generation: 1,
    pendingAddress: address,
    committedAddress: address,
    recoveryAddress: address,
    title: "Example",
    favicon: null,
    phase: "loaded",
    mainFrameError: null,
    mainFrameErrorCode: null,
    navigation: null,
    documentAccess: "unknown",
  };
}

describe("BrowserSurfacePresentationCoordinator", () => {
  let host: { present: ReturnType<typeof vi.fn>; hide: ReturnType<typeof vi.fn> };
  let coordinator: BrowserSurfacePresentationCoordinator;

  beforeEach(() => {
    host = { present: vi.fn(), hide: vi.fn() };
    coordinator = new BrowserSurfacePresentationCoordinator(host as unknown as BrowserSurfaceHost);
  });

  afterEach(() => coordinator.dispose());

  it("gives a visible panel precedence and forwards bounded presentation intent", () => {
    coordinator.publish(identity, {
      source: "automation",
      active: true,
      pageState: page(),
    });
    coordinator.publish(identity, {
      source: "panel",
      active: true,
      anchor: panelRect,
      pageState: page(),
    });

    expect(host.present).toHaveBeenLastCalledWith(identity, expect.objectContaining({
      left: 10,
      top: 20,
      width: 640,
      height: 480,
      inputEnabled: true,
      accessible: true,
    }));
    expect(host.hide).not.toHaveBeenCalled();
  });

  it("clips overlap in intrinsic coordinates when responsive scale is below one", () => {
    coordinator.setActivityRailOverlap(112);
    coordinator.publish(identity, {
      source: "panel",
      active: true,
      anchor: panelRect,
      pageState: page(),
      viewport: { width: 1280, height: 960 },
    });

    expect(host.present).toHaveBeenLastCalledWith(identity, expect.objectContaining({
      scale: 0.5,
      coveredLeft: 224,
    }));
  });

  it("keeps a loaded automation surface warm offscreen and non-interactive", () => {
    coordinator.publish(identity, {
      source: "automation",
      active: true,
      pageState: page(),
    });

    expect(host.present).toHaveBeenLastCalledWith(identity, expect.objectContaining({
      left: -20_000,
      inputEnabled: false,
      accessible: false,
    }));
  });

  it.each([
    ["first", "second"],
    ["second", "first"],
  ])("recomputes automation presentation when duplicate anchors unregister in %s-first order", (firstRelease, secondRelease) => {
    const first = document.createElement("div");
    const second = document.createElement("div");
    for (const element of [first, second]) {
      vi.spyOn(element, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 20, 640, 480));
    }
    const releaseFirst = coordinator.registerAutomationAnchor("workspace-1", "thread-1", first);
    const releaseSecond = coordinator.registerAutomationAnchor("workspace-1", "thread-1", second);
    coordinator.publish(identity, { source: "automation", active: true, pageState: page() });
    host.hide.mockClear();

    const registrations = { first: releaseFirst, second: releaseSecond };
    registrations[firstRelease as "first" | "second"]();
    expect(host.present).toHaveBeenLastCalledWith(identity, expect.objectContaining({
      left: 10,
      top: 20,
      inputEnabled: false,
      accessible: false,
    }));
    expect(host.hide).not.toHaveBeenCalled();
    registrations[secondRelease as "first" | "second"]();
    expect(host.present).toHaveBeenLastCalledWith(identity, expect.objectContaining({
      left: -20_000,
      inputEnabled: false,
      accessible: false,
    }));
  });

  it.each([
    ["first", "second"],
    ["second", "first"],
  ])("recomputes panel presentation after releasing the %s duplicate registration", (firstRelease, secondRelease) => {
    const first = document.createElement("div");
    const second = document.createElement("div");
    vi.spyOn(first, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 20, 640, 480));
    vi.spyOn(second, "getBoundingClientRect").mockReturnValue(new DOMRect(30, 40, 320, 240));
    const firstRegistration = coordinator.registerAnchor(identity, "panel", first);
    const secondRegistration = coordinator.registerAnchor(identity, "panel", second);
    coordinator.publish(identity, { source: "panel", active: true, anchor: first, pageState: page() }, firstRegistration.token);
    coordinator.publish(identity, { source: "panel", active: true, anchor: second, pageState: page() }, secondRegistration.token);
    host.hide.mockClear();

    const registrations = { first: firstRegistration, second: secondRegistration };
    registrations[firstRelease as "first" | "second"].release();
    expect(host.present).toHaveBeenLastCalledWith(identity, expect.objectContaining({
      left: firstRelease === "first" ? 30 : 10,
      top: firstRelease === "first" ? 40 : 20,
    }));
    expect(host.hide).not.toHaveBeenCalled();

    registrations[secondRelease as "first" | "second"].release();
    expect(host.hide).toHaveBeenCalledWith(identity);
  });

  it.each([
    ["inactive", { active: false, pageState: page() }],
    ["blank", { active: true, anchor: panelRect, pageState: page("about:blank") }],
    ["error", { active: true, anchor: panelRect, pageState: { ...page(), phase: "error" as const } }],
  ])("hides %s intent and keeps the surface inaccessible", (_label, intent) => {
    coordinator.publish(identity, { source: "panel", ...intent });
    expect(host.hide).toHaveBeenCalledWith(identity);
    expect(host.present).not.toHaveBeenCalled();
  });

  it("hides a zero-layout panel without discarding its identity", () => {
    coordinator.publish(identity, {
      source: "panel",
      active: true,
      anchor: { left: 10, top: 20, width: 0, height: 0 },
      pageState: page(),
    });

    expect(host.hide).toHaveBeenCalledWith(identity);
    expect(host.present).not.toHaveBeenCalled();
  });
});
