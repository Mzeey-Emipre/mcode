import { describe, it, expect, beforeEach, vi } from "vitest";
import { useSkillsStore } from "./skillsStore";

const FAKE_SKILLS = [
  { name: "a", description: "A", kind: "skill" as const, source: "user" as const, providers: ["claude"] },
];

// Hoist the mock so the invalidate-then-reload test can assert call counts.
// Without a stable reference, every getTransport() call would return a fresh
// vi.fn() and the second load() would never be observable.
const listSkillsMock = vi.fn(async () => FAKE_SKILLS);

vi.mock("@/transport", () => ({
  getTransport: () => ({
    listSkills: listSkillsMock,
  }),
}));

describe("skillsStore", () => {
  beforeEach(() => {
    listSkillsMock.mockClear();
    useSkillsStore.getState().reset();
  });

  it("loads skills and caches them per cwd", async () => {
    await useSkillsStore.getState().load("/foo");
    expect(useSkillsStore.getState().skills).toEqual(FAKE_SKILLS);
    expect(useSkillsStore.getState().cwd).toBe("/foo");
  });

  it("single-flights concurrent load() calls", async () => {
    const p1 = useSkillsStore.getState().load("/foo");
    const p2 = useSkillsStore.getState().load("/foo");
    expect(p1).toBe(p2); // same in-flight promise
    await Promise.all([p1, p2]);
  });

  it("invalidate() clears cache so next load() re-fetches", async () => {
    await useSkillsStore.getState().load("/foo");
    useSkillsStore.getState().invalidate();
    expect(useSkillsStore.getState().skills).toBeNull();

    // The visible-state assertion above is necessary but not sufficient: if
    // invalidate() left the module-scoped TTL or in-flight reference behind,
    // the next load() could short-circuit to the stale promise without ever
    // hitting transport. Calling load() again and asserting two transport
    // hits is what actually proves the cache was cleared.
    await useSkillsStore.getState().load("/foo");
    expect(listSkillsMock).toHaveBeenCalledTimes(2);
    expect(useSkillsStore.getState().skills).toEqual(FAKE_SKILLS);
  });

  it("does not single-flight loads for different cwds", async () => {
    // Two concurrent loads with different cwds must NOT share a promise:
    // workspace B would receive workspace A's data otherwise.
    const p1 = useSkillsStore.getState().load("/foo");
    const p2 = useSkillsStore.getState().load("/bar");
    expect(p1).not.toBe(p2);
    await Promise.all([p1, p2]);
  });

  it("invalidate() fences a load() that's still in flight", async () => {
    // Slow the next mock response so we can race invalidate() against it.
    let resolveListSkills!: (v: typeof FAKE_SKILLS) => void;
    listSkillsMock.mockImplementationOnce(
      () => new Promise((res) => { resolveListSkills = res; }),
    );

    const loadPromise = useSkillsStore.getState().load("/foo");
    // While load is in flight, an external watcher fires invalidate().
    useSkillsStore.getState().invalidate();
    // Now resolve the in-flight fetch with data — it must NOT rehydrate
    // the store, because invalidate() bumped the load epoch.
    resolveListSkills(FAKE_SKILLS);
    await loadPromise;

    // Store stays cleared: the late resolution was dropped.
    expect(useSkillsStore.getState().skills).toBeNull();
    expect(useSkillsStore.getState().cwd).toBeUndefined();
    // Regression: the in-flight load's fenced resolve must not leave
    // isLoading stuck at true. If it did, useSlashCommand's eager-prefetch
    // effect would early-return forever (`if (isLoading) return`), and the
    // popup would show only built-in commands until the user clicks Refresh.
    expect(useSkillsStore.getState().isLoading).toBe(false);
  });

  it("recovers after invalidate-during-load race: next load repopulates skills", async () => {
    // Drives the user-visible symptom end-to-end: cold-start race where
    // `skills.changed` arrives during the very first prefetch. Without the
    // isLoading reset in invalidate(), `useSlashCommand`'s eager-prefetch
    // effect would never fire a follow-up load and the popup would stick.
    let resolveFirst!: (v: typeof FAKE_SKILLS) => void;
    listSkillsMock.mockImplementationOnce(
      () => new Promise((res) => { resolveFirst = res; }),
    );

    const first = useSkillsStore.getState().load("/foo");
    useSkillsStore.getState().invalidate();
    resolveFirst(FAKE_SKILLS);
    await first;

    // The consumer hook's effect would early-return if isLoading is stuck.
    expect(useSkillsStore.getState().isLoading).toBe(false);

    // Subsequent load mirrors what the effect would dispatch once it sees
    // !isLoading and skills === null. It must repopulate the store.
    await useSkillsStore.getState().load("/foo");
    expect(useSkillsStore.getState().skills).toEqual(FAKE_SKILLS);
    expect(useSkillsStore.getState().isLoading).toBe(false);
  });

  it("tracks cwd on failure so the consumer can detect cwd changes", async () => {
    listSkillsMock.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    await expect(useSkillsStore.getState().load("/foo")).rejects.toThrow("boom");
    // cwd must reflect the *attempted* path even though no skills loaded.
    // Without this, useSlashCommand cannot distinguish "retry same cwd"
    // (don't auto-loop) from "user switched workspace" (must reload).
    expect(useSkillsStore.getState().cwd).toBe("/foo");
    expect(useSkillsStore.getState().error?.message).toBe("boom");
  });

  it("retries once after WebSocket disconnect", async () => {
    const calls: number[] = [];
    vi.doMock("@/transport", () => ({
      getTransport: () => ({
        listSkills: vi.fn(async () => {
          calls.push(Date.now());
          if (calls.length === 1) throw new Error("WebSocket disconnected");
          return FAKE_SKILLS;
        }),
        waitForConnection: async () => undefined,
      }),
    }));

    vi.resetModules();
    const { useSkillsStore: store } = await import("./skillsStore");
    store.getState().reset();
    const result = await store.getState().load("/foo");
    expect(result).toEqual(FAKE_SKILLS);
    expect(calls.length).toBe(2);
  });
});

describe("provider-scoped caching", () => {
  beforeEach(() => {
    listSkillsMock.mockClear();
    useSkillsStore.getState().reset();
  });

  it("re-fetches when providerId changes", async () => {
    await useSkillsStore.getState().load("/foo", "claude");
    listSkillsMock.mockClear();
    await useSkillsStore.getState().load("/foo", "codex");
    expect(listSkillsMock).toHaveBeenCalledTimes(1); // cache miss — different provider
  });

  it("returns cached data when cwd and providerId both match", async () => {
    await useSkillsStore.getState().load("/foo", "claude");
    listSkillsMock.mockClear();
    await useSkillsStore.getState().load("/foo", "claude");
    expect(listSkillsMock).not.toHaveBeenCalled(); // cache hit
  });

  it("passes providerId through to RPC call", async () => {
    await useSkillsStore.getState().load("/foo", "codex");
    expect(listSkillsMock).toHaveBeenCalledWith("/foo", "codex");
  });

  it("scopes single-flight by cwd + providerId", async () => {
    const p1 = useSkillsStore.getState().load("/foo", "claude");
    const p2 = useSkillsStore.getState().load("/foo", "codex");
    expect(p1).not.toBe(p2); // different providers = different in-flight promises
    await Promise.all([p1, p2]);
  });

  it("retains concurrent provider caches without making either consumer refetch", async () => {
    const claude = useSkillsStore.getState().load("/foo", "claude");
    const unscoped = useSkillsStore.getState().load("/foo", undefined);
    await Promise.all([claude, unscoped]);

    await useSkillsStore.getState().load("/foo", "claude");
    await useSkillsStore.getState().load("/foo", undefined);

    expect(listSkillsMock).toHaveBeenCalledTimes(2);
  });
});
