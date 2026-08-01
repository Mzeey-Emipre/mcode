import { beforeEach, describe, expect, it } from "vitest";
import { BrowserTargetRegistry } from "./browserTargetRegistry";

describe("BrowserTargetRegistry", () => {
  let registry: BrowserTargetRegistry;

  beforeEach(() => {
    registry = new BrowserTargetRegistry();
  });

  it("retains the logical record across detach and reattach", () => {
    const first = registry.register("workspace", "thread", "tab");
    registry.detach("thread", "tab");
    const second = registry.register("workspace", "thread", "tab");

    expect(second.revision).toBe(first.revision);
    expect(registry.get("thread", "tab")?.attached).toBe(true);
  });

  it("releases records only for authoritative scopes", () => {
    registry.register("workspace-a", "thread-a", "tab-a");
    registry.register("workspace-b", "thread-b", "tab-b");
    registry.detach("thread-a", "tab-a");
    expect(registry.get("thread-a", "tab-a")).not.toBeNull();

    registry.releaseThread("thread-a");
    expect(registry.get("thread-a", "tab-a")).toBeNull();
    expect(registry.get("thread-b", "tab-b")).not.toBeNull();

    registry.releaseWorkspace("workspace-b");
    expect(registry.get("thread-b", "tab-b")).toBeNull();
  });
});
