import { describe, expect, it } from "vitest";
import {
  BrowserSurfaceHost,
  type BrowserSurfaceAdapterFactory,
  type BrowserSurfaceIdentity,
} from "../BrowserSurfaceHost";

const IDENTITY: BrowserSurfaceIdentity = {
  workspaceId: "contract-workspace",
  scope: { kind: "thread", id: "contract-thread" },
  tabId: "contract-tab",
};

/** Runs the durable lifecycle contract against any Browser surface adapter. */
export function runBrowserSurfaceContract(name: string, adapterFactory: BrowserSurfaceAdapterFactory): void {
  describe(name, () => {
    it("creates, presents, hides, and disposes one exact identity", () => {
      const host = new BrowserSurfaceHost({ adapterFactory });
      const snapshot = host.create(IDENTITY);
      expect(snapshot.identity).toEqual(IDENTITY);
      host.present(IDENTITY, { left: 0, top: 0, width: 640, height: 480 });
      host.hide(IDENTITY);
      expect(host.ensure(IDENTITY)).toBe(snapshot);
      expect(host.getSnapshot(IDENTITY)?.generation).toBe(snapshot.generation);
      host.dispose(IDENTITY);
      expect(host.getSnapshot(IDENTITY)).toBeNull();
      host.disposeHost();
    });

    it("isolates complete identity and rejects stale generation events", () => {
      const host = new BrowserSurfaceHost({ adapterFactory });
      const other: BrowserSurfaceIdentity = { ...IDENTITY, workspaceId: "other-workspace" };
      host.create(IDENTITY);
      host.create(other);
      const before = host.getSnapshot(other);
      host.handleEvent({ type: "title-updated", identity: IDENTITY, generation: 999, title: "stale" });
      expect(host.getSnapshot(other)).toBe(before);
      host.disposeHost();
    });

    it("preserves state object identity for semantic navigation no-ops", () => {
      const host = new BrowserSurfaceHost({ adapterFactory });
      host.create(IDENTITY);
      host.handleEvent({ type: "navigation-state", identity: IDENTITY, generation: 1, navigation: { canGoBack: false, canGoForward: false } });
      const snapshot = host.getSnapshot(IDENTITY);
      host.handleEvent({ type: "navigation-state", identity: IDENTITY, generation: 1, navigation: { canGoBack: false, canGoForward: false } });
      expect(host.getSnapshot(IDENTITY)).toBe(snapshot);
      host.disposeHost();
    });
  });
}
