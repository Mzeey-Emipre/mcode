import { describe, it, expect, vi } from "vitest";
import { OpenInRegistry } from "../registry";
import type { LaunchTarget, OpenInAdapter } from "../../contracts/types";

/** Build a fake adapter that records its launches instead of spawning anything. */
function fakeAdapter(
  overrides: Partial<OpenInAdapter> & { id: string },
): OpenInAdapter & { launches: LaunchTarget[] } {
  const launches: LaunchTarget[] = [];
  return {
    id: overrides.id,
    label: overrides.label ?? overrides.id,
    kind: overrides.kind ?? "editor",
    iconKey: overrides.iconKey ?? overrides.id,
    detect: overrides.detect ?? (() => true),
    launch:
      overrides.launch ??
      ((target: LaunchTarget) => {
        launches.push(target);
        return Promise.resolve();
      }),
    launches,
  };
}

describe("OpenInRegistry", () => {
  describe("list", () => {
    it("composes metadata and detection from each adapter, in registration order", () => {
      const registry = new OpenInRegistry([
        fakeAdapter({ id: "code", label: "VS Code", kind: "editor", iconKey: "vscode", detect: () => true }),
        fakeAdapter({ id: "vs", label: "Visual Studio", kind: "editor", iconKey: "visualstudio", detect: () => false }),
        fakeAdapter({ id: "zed", label: "Zed", kind: "editor", iconKey: "zed", detect: () => false }),
        fakeAdapter({ id: "github-desktop", label: "GitHub Desktop", kind: "gitGui", iconKey: "githubDesktop", detect: () => true }),
        fakeAdapter({ id: "explorer", label: "File Explorer", kind: "fileManager", iconKey: "explorer", detect: () => true }),
      ]);

      expect(registry.list()).toEqual([
        { id: "code", label: "VS Code", kind: "editor", iconKey: "vscode", detected: true },
        { id: "vs", label: "Visual Studio", kind: "editor", iconKey: "visualstudio", detected: false },
        { id: "zed", label: "Zed", kind: "editor", iconKey: "zed", detected: false },
        { id: "github-desktop", label: "GitHub Desktop", kind: "gitGui", iconKey: "githubDesktop", detected: true },
        { id: "explorer", label: "File Explorer", kind: "fileManager", iconKey: "explorer", detected: true },
      ]);
    });

    it("calls detect() on every list() so installation status stays live", () => {
      const detect = vi.fn().mockReturnValue(true);
      const registry = new OpenInRegistry([fakeAdapter({ id: "code", detect })]);

      registry.list();
      registry.list();

      expect(detect).toHaveBeenCalledTimes(2);
    });
  });

  describe("launch", () => {
    it("dispatches to the matching adapter with the target", async () => {
      const code = fakeAdapter({ id: "code" });
      const zed = fakeAdapter({ id: "zed" });
      const registry = new OpenInRegistry([code, zed]);

      await registry.launch("zed", { path: "/abs/file.ts", line: 42 });

      expect(zed.launches).toEqual([{ path: "/abs/file.ts", line: 42 }]);
      expect(code.launches).toEqual([]);
    });

    it("rejects for an unknown app id", async () => {
      const registry = new OpenInRegistry([fakeAdapter({ id: "code" })]);

      await expect(registry.launch("ghost", { path: "/abs/x" })).rejects.toThrow(
        /Unknown open-in app: ghost/,
      );
    });

    it("propagates a rejection from the adapter's launch", async () => {
      const registry = new OpenInRegistry([
        fakeAdapter({
          id: "code",
          launch: () => Promise.reject(new Error("spawn failed")),
        }),
      ]);

      await expect(registry.launch("code", { path: "/abs/x" })).rejects.toThrow(
        /spawn failed/,
      );
    });
  });
});
