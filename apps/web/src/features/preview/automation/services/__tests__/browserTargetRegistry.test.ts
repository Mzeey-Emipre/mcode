import { beforeEach, describe, expect, it } from "vitest";
import { BrowserTargetRegistry } from "../browserTargetRegistry";

describe("BrowserTargetRegistry", () => {
  let registry: BrowserTargetRegistry;
  const workspaceId = "workspace-1";

  beforeEach(() => {
    registry = new BrowserTargetRegistry();
  });

  it("retains the logical record across detach and reattach", () => {
    const first = registry.register(workspaceId, "thread", "tab");
    registry.detach(workspaceId, "thread", "tab");
    const second = registry.register(workspaceId, "thread", "tab");

    expect(second.revision).toBe(first.revision);
    expect(registry.get(workspaceId, "thread", "tab")?.attached).toBe(true);
  });

  it("releases records only for authoritative scopes", () => {
    registry.register("workspace-a", "thread-a", "tab-a");
    registry.register("workspace-b", "thread-b", "tab-b");
    registry.detach("workspace-a", "thread-a", "tab-a");
    expect(registry.get("workspace-a", "thread-a", "tab-a")).not.toBeNull();

    registry.releaseThread("workspace-a", "thread-a");
    expect(registry.get("workspace-a", "thread-a", "tab-a")).toBeNull();
    expect(registry.get("workspace-b", "thread-b", "tab-b")).not.toBeNull();

    registry.releaseWorkspace("workspace-b");
    expect(registry.get("workspace-b", "thread-b", "tab-b")).toBeNull();
  });
});
