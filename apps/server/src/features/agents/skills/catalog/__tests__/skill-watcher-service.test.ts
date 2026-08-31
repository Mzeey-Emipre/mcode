import "reflect-metadata";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { SkillService } from "../skill-service.js";
import { SkillWatcherService } from "../skill-watcher-service.js";

function tmp() {
  return NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "skill-watch-"));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(predicate()).toBe(true);
}

describe("SkillWatcherService", () => {
  let dir: string;
  let svc: SkillService;
  let watcher: SkillWatcherService;

  beforeEach(() => {
    dir = tmp();
    svc = new SkillService();
    watcher = new SkillWatcherService(svc);
  });

  afterEach(() => {
    watcher.stopAll();
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  it("invalidates the SkillService cache when a watched dir changes", async () => {
    NodeFS.mkdirSync(NodePath.join(dir, "skills"), { recursive: true });
    const invalidateSpy = vi.spyOn(svc, "invalidate");

    watcher.watch(dir);
    // Trigger a change event
    NodeFS.writeFileSync(NodePath.join(dir, "skills", "marker.txt"), "x");

    await waitFor(() => invalidateSpy.mock.calls.length > 0);
    expect(invalidateSpy).toHaveBeenCalled();
  });

  it("debounces rapid changes into a single invalidation", async () => {
    NodeFS.mkdirSync(NodePath.join(dir, "skills"), { recursive: true });
    const invalidateSpy = vi.spyOn(svc, "invalidate");

    watcher.watch(dir);
    for (let i = 0; i < 5; i++) {
      NodeFS.writeFileSync(NodePath.join(dir, "skills", `f${i}.txt`), "x");
    }

    await waitFor(() => invalidateSpy.mock.calls.length > 0);
    await new Promise((r) => setTimeout(r, 250));
    expect(invalidateSpy.mock.calls.length).toBe(1);
  });

  it("watch() on a missing directory does not throw", () => {
    expect(() => watcher.watch(NodePath.join(dir, "does-not-exist"))).not.toThrow();
  });

  it("watch() dedupes by directory path: a second call for the same dir is a no-op", async () => {
    NodeFS.mkdirSync(NodePath.join(dir, "skills"), { recursive: true });
    const target = NodePath.join(dir, "skills");
    const invalidateSpy = vi.spyOn(svc, "invalidate");

    watcher.watch(target);
    watcher.watch(target);

    // Trigger one fs change. With dedup the debounced invalidate fires once;
    // without dedup, two FSWatchers would each schedule the timer (the second
    // resets it), and the eventual single timer fire would still call
    // invalidate once — so call count alone is insufficient. The real
    // assertion is that we never registered a second underlying watcher.
    NodeFS.writeFileSync(NodePath.join(target, "marker.txt"), "x");
    await waitFor(() => invalidateSpy.mock.calls.length > 0);
    await new Promise((r) => setTimeout(r, 250));
    expect(invalidateSpy).toHaveBeenCalledTimes(1);

    // stopAll() must close every registered watcher; if dedup leaked a second
    // watcher into the array, this assertion would still pass but the dir
    // would remain watched after stopAll(). Verify via internal state.
    expect((watcher as unknown as { watchers: unknown[] }).watchers.length).toBe(1);
  });

  it("auto-registers a root that is created after start()", async () => {
    // Simulates a fresh-install scenario: ~/.claude exists but the
    // skills/commands/plugins child dirs don't yet. Without parent-dir
    // watching, those roots would never be picked up until a process
    // restart.
    const root = NodePath.join(dir, "skills");
    // dir (parent) exists; root does not.

    watcher.start({ parentDirs: [dir], roots: [root] });

    const invalidateSpy = vi.spyOn(svc, "invalidate");

    // Create the missing root after start() — this should be observed by
    // the parent watcher and trigger a delayed registration of `root`.
    NodeFS.mkdirSync(root, { recursive: true });
    // Let the parent-triggered debounce flush; that fires onChange once
    // for the parent, which alone could satisfy a naive call-count assert.
    // Clearing the spy after this isolates the next assertion to the
    // late-registered root's own watcher.
    await waitFor(() => invalidateSpy.mock.calls.length > 0);
    invalidateSpy.mockClear();

    // A change inside the late-registered root must invalidate exactly once.
    NodeFS.writeFileSync(NodePath.join(root, "marker.txt"), "x");
    await waitFor(() => invalidateSpy.mock.calls.length > 0);
    await new Promise((r) => setTimeout(r, 250));
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps Codex roots outside the shared filesystem watcher", () => {
    const watchSpy = vi.spyOn(watcher, "watch");

    watcher.start();
    const watchedPaths = watchSpy.mock.calls.map((call) => call[0] as string);

    expect(watchedPaths.some((p) => p.includes(".codex"))).toBe(false);
    expect(watchedPaths.some((p) => p.replace(/\\/g, "/").includes(".claude/.agents/skills"))).toBe(true);
    expect(watchedPaths.some((p) => p.replace(/\\/g, "/").includes(".agents/commands"))).toBe(false);
    expect(watchedPaths.some((p) => p.replace(/\\/g, "/").includes(".cursor/skills"))).toBe(true);
  });

  it("auto-registers roots from multiple parent directories", async () => {
    // Simulate two non-Codex provider parent directories existing at startup.
    const claudeParent = NodePath.join(dir, ".claude");
    const cursorParent = NodePath.join(dir, ".cursor");
    NodeFS.mkdirSync(claudeParent, { recursive: true });
    NodeFS.mkdirSync(cursorParent, { recursive: true });

    const cursorRoot = NodePath.join(cursorParent, "skills");

    watcher.start({
      parentDirs: [claudeParent, cursorParent],
      roots: [NodePath.join(claudeParent, "skills"), cursorRoot],
    });

    const invalidateSpy = vi.spyOn(svc, "invalidate");

    NodeFS.mkdirSync(cursorRoot, { recursive: true });
    await waitFor(() => invalidateSpy.mock.calls.length > 0);
    invalidateSpy.mockClear();

    NodeFS.writeFileSync(NodePath.join(cursorRoot, "marker.txt"), "x");
    await waitFor(() => invalidateSpy.mock.calls.length > 0);
    await new Promise((r) => setTimeout(r, 250));
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });

  it("start() is idempotent: a second call from a clean state does not call watch() again", () => {
    // Spy on watch() so the assertion is independent of which `~/.claude/*`
    // subdirs happen to exist on the host (CI typically has none, in which
    // case watch() short-circuits and never pushes to `watchers`). Counting
    // watch() invocations directly proves the `started` guard, not the
    // downstream watcher-registration side effect.
    const watchSpy = vi.spyOn(watcher, "watch");

    watcher.start();
    const firstCallCount = watchSpy.mock.calls.length;
    expect(firstCallCount).toBeGreaterThan(0);

    watcher.start();
    expect(watchSpy.mock.calls.length).toBe(firstCallCount);
  });
});
