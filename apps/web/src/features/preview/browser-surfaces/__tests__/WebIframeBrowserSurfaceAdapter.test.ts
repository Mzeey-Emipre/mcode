import { describe, expect, it } from "vitest";
import {
  createWebIframeBrowserSurfaceAdapterFactory,
  WebIframeBrowserSurfaceAdapter,
} from "../WebIframeBrowserSurfaceAdapter";
import type { BrowserSurfaceIdentity } from "../BrowserSurfaceHost";
import { runBrowserSurfaceContract } from "./browserSurfaceContract";

const IDENTITY: BrowserSurfaceIdentity = {
  workspaceId: "workspace-a",
  scope: { kind: "workspace", id: "workspace-a" },
  tabId: "tab-a",
};

runBrowserSurfaceContract(
  "Web iframe BrowserSurfaceHost contract",
  createWebIframeBrowserSurfaceAdapterFactory({ root: document.body }),
);

describe("WebIframeBrowserSurfaceAdapter", () => {
  it("owns a stable, identity-bound iframe and bounded presentation", () => {
    const adapter = new WebIframeBrowserSurfaceAdapter(IDENTITY, 7, { root: document.body, title: "Preview" });
    expect(adapter.element.dataset).toMatchObject({
      testid: "web-runtime-preview-iframe",
      workspaceId: IDENTITY.workspaceId,
      scopeKind: IDENTITY.scope.kind,
      scopeId: IDENTITY.scope.id,
      tabId: IDENTITY.tabId,
      generation: "7",
    });
    expect(adapter.element.title).toBe("Preview");
    adapter.present({ left: 10, top: 20, width: 640, height: 480, scale: 1.25, zIndex: 42, coveredLeft: 112 });
    expect(adapter.element.style.left).toBe("10px");
    expect(adapter.element.style.width).toBe("640px");
    expect(adapter.element.style.zIndex).toBe("42");
    expect(adapter.element.style.clipPath).toBe("inset(0px 0px 0px 112px)");
    adapter.dispose();
    expect(document.body.contains(adapter.element)).toBe(false);
  });

  it("applies explicit input and accessibility state", () => {
    const adapter = new WebIframeBrowserSurfaceAdapter(IDENTITY, 2, { root: document.body });

    adapter.present({ left: 0, top: 0, width: 640, height: 480, inputEnabled: false, accessible: false });
    expect(adapter.element.style.pointerEvents).toBe("none");
    expect(adapter.element).toHaveAttribute("aria-hidden", "true");

    adapter.present({ left: 0, top: 0, width: 640, height: 480, inputEnabled: true, accessible: true });
    expect(adapter.element.style.pointerEvents).toBe("auto");
    expect(adapter.element).toHaveAttribute("aria-hidden", "false");
    adapter.dispose();
  });

  it("reports cross-origin observation as unknown and history as null", () => {
    const adapter = new WebIframeBrowserSurfaceAdapter(IDENTITY, 1, { root: document.body });
    const events: string[] = [];
    adapter.subscribe((event) => {
      if (event.type === "title-updated") events.push(`title:${event.title ?? "null"}`);
      if (event.type === "favicon-updated") events.push(`favicon:${event.favicon ?? "null"}`);
      if (event.type === "navigation-state") events.push(`navigation:${event.navigation === null ? "null" : "known"}`);
      if (event.type === "document-access") events.push(`access:${event.access}`);
    });
    adapter.navigate("https://cross-origin.test/page");
    adapter.element.dispatchEvent(new Event("load"));
    expect(events).toContain("title:null");
    expect(events).toContain("favicon:null");
    expect(events).toContain("navigation:null");
    expect(events).toContain("access:cross-origin");
    adapter.dispose();
  });

  it("rejects unsafe addresses before assigning iframe src", () => {
    const adapter = new WebIframeBrowserSurfaceAdapter(IDENTITY, 1, { root: document.body });
    expect(() => adapter.navigate("javascript:alert(1)")).toThrow(TypeError);
    expect(adapter.element).not.toHaveAttribute("src");
    adapter.dispose();
  });
});
