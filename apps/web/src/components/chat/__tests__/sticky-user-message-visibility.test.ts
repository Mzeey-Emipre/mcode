import { describe, expect, it } from "vitest";
import {
  shouldShowStickyUserMessage,
  STICKY_HIDE_IN_VIEW_PX,
  STICKY_SHOW_ABOVE_VIEWPORT_PX,
} from "../sticky-user-message-visibility";

describe("shouldShowStickyUserMessage", () => {
  it("returns false when the message is still visible in the viewport", () => {
    const container = document.createElement("div");
    Object.defineProperty(container, "clientHeight", { value: 400 });
    Object.defineProperty(container, "scrollTop", { value: 0, writable: true });

    const message = document.createElement("div");
    message.setAttribute("data-message-id", "msg-1");
    container.appendChild(message);

    container.getBoundingClientRect = () =>
      ({ top: 0, bottom: 400, left: 0, right: 300, width: 300, height: 400, x: 0, y: 0, toJSON: () => ({}) });
    message.getBoundingClientRect = () =>
      ({ top: 40, bottom: 120, left: 0, right: 300, width: 300, height: 80, x: 0, y: 40, toJSON: () => ({}) });

    expect(
      shouldShowStickyUserMessage(container, "msg-1", 0, { getVirtualItems: () => [] }),
    ).toBe(false);
  });

  it("returns true when the message has scrolled fully above the viewport", () => {
    const container = document.createElement("div");
    Object.defineProperty(container, "clientHeight", { value: 400 });
    Object.defineProperty(container, "scrollTop", { value: 240, writable: true });

    const message = document.createElement("div");
    message.setAttribute("data-message-id", "msg-1");
    container.appendChild(message);

    container.getBoundingClientRect = () =>
      ({ top: 0, bottom: 400, left: 0, right: 300, width: 300, height: 400, x: 0, y: 0, toJSON: () => ({}) });
    message.getBoundingClientRect = () =>
      ({
        top: -48,
        bottom: -(STICKY_SHOW_ABOVE_VIEWPORT_PX + 1),
        left: 0,
        right: 300,
        width: 300,
        height: 39,
        x: 0,
        y: -48,
        toJSON: () => ({}),
      });

    expect(
      shouldShowStickyUserMessage(container, "msg-1", 0, { getVirtualItems: () => [] }),
    ).toBe(true);
  });

  it("returns false when the message is only partially clipped at the top", () => {
    const container = document.createElement("div");
    Object.defineProperty(container, "clientHeight", { value: 400 });
    Object.defineProperty(container, "scrollTop", { value: 240, writable: true });

    const message = document.createElement("div");
    message.setAttribute("data-message-id", "msg-1");
    container.appendChild(message);

    container.getBoundingClientRect = () =>
      ({ top: 0, bottom: 400, left: 0, right: 300, width: 300, height: 400, x: 0, y: 0, toJSON: () => ({}) });
    message.getBoundingClientRect = () =>
      ({ top: -10, bottom: 12, left: 0, right: 300, width: 300, height: 22, x: 0, y: -10, toJSON: () => ({}) });

    expect(
      shouldShowStickyUserMessage(container, "msg-1", 0, { getVirtualItems: () => [] }),
    ).toBe(false);
  });

  it("keeps the sticky bar on through partial clip when already visible", () => {
    const container = document.createElement("div");
    Object.defineProperty(container, "clientHeight", { value: 400 });
    Object.defineProperty(container, "scrollTop", { value: 240, writable: true });

    const message = document.createElement("div");
    message.setAttribute("data-message-id", "msg-1");
    container.appendChild(message);

    container.getBoundingClientRect = () =>
      ({ top: 0, bottom: 400, left: 0, right: 300, width: 300, height: 400, x: 0, y: 0, toJSON: () => ({}) });
    message.getBoundingClientRect = () =>
      ({ top: -10, bottom: STICKY_HIDE_IN_VIEW_PX, left: 0, right: 300, width: 300, height: 22, x: 0, y: -10, toJSON: () => ({}) });

    expect(
      shouldShowStickyUserMessage(container, "msg-1", 0, { getVirtualItems: () => [] }, true),
    ).toBe(true);
  });

  it("returns true when the virtual row is above the rendered range", () => {
    const container = document.createElement("div");
    Object.defineProperty(container, "clientHeight", { value: 400 });
    Object.defineProperty(container, "scrollTop", { value: 500, writable: true });

    expect(
      shouldShowStickyUserMessage(container, "msg-1", 2, {
        getVirtualItems: () => [{ index: 5, start: 600, size: 80 }],
      }),
    ).toBe(true);
  });

  describe("virtualizer fallback hysteresis (no DOM node)", () => {
    const scrollTop = 240;

    function containerWithoutDom(): HTMLDivElement {
      const container = document.createElement("div");
      Object.defineProperty(container, "clientHeight", { value: 400 });
      Object.defineProperty(container, "scrollTop", { value: scrollTop, writable: true });
      return container;
    }

    /** Virtual row for item 0 whose bottom edge sits `bottomPx` below the viewport top. */
    function virtualizerAtMessageBottom(bottomPx: number): {
      getVirtualItems: () => ReadonlyArray<{ index: number; start: number; size: number }>;
    } {
      const rowEnd = scrollTop + bottomPx;
      return {
        getVirtualItems: () => [{ index: 0, start: rowEnd - 52, size: 52 }],
      };
    }

    it("returns false when the virtual row is only partially clipped at the top", () => {
      const container = containerWithoutDom();
      const virtualizer = virtualizerAtMessageBottom(12);

      expect(
        shouldShowStickyUserMessage(container, "msg-1", 0, virtualizer, false),
      ).toBe(false);
    });

    it("returns true when the virtual row bottom is at the hide-in-view boundary and sticky is already on", () => {
      const container = containerWithoutDom();
      const virtualizer = virtualizerAtMessageBottom(STICKY_HIDE_IN_VIEW_PX);

      expect(
        shouldShowStickyUserMessage(container, "msg-1", 0, virtualizer, true),
      ).toBe(true);
    });

    it("returns false when the virtual row bottom is just past the hide-in-view boundary", () => {
      const container = containerWithoutDom();
      const virtualizer = virtualizerAtMessageBottom(STICKY_HIDE_IN_VIEW_PX + 1);

      expect(
        shouldShowStickyUserMessage(container, "msg-1", 0, virtualizer, true),
      ).toBe(false);
    });

    it("returns true when the virtual row is fully above the show threshold", () => {
      const container = containerWithoutDom();
      const virtualizer = virtualizerAtMessageBottom(-(STICKY_SHOW_ABOVE_VIEWPORT_PX + 1));

      expect(
        shouldShowStickyUserMessage(container, "msg-1", 0, virtualizer, false),
      ).toBe(true);
    });
  });
});
