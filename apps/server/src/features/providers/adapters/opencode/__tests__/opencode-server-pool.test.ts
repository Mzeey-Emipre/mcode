import { describe, expect, it, vi } from "vitest";
import { OpenCodeServerPool, OPENCODE_POOL_IDLE_TTL_MS } from "../opencode-server-pool.js";

function fakeDeps(overrides: Record<string, unknown> = {}) {
  const listeners = new Map<string, Array<(...args: never[]) => void>>();
  const child = {
    pid: 4242,
    on: vi.fn((event: string, listener: (...args: never[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    }),
    off: vi.fn(),
    kill: vi.fn(() => true),
  };
  return {
    child,
    listeners,
    deps: {
      spawn: vi.fn(() => child),
      waitForHealth: vi.fn(async () => {}),
      terminateTree: vi.fn(async () => {}),
      findFreePort: vi.fn(async () => 4096),
      now: vi.fn(() => 1_000),
      env: vi.fn(() => ({})),
      ...overrides,
    } as never,
  };
}

describe("OpenCodeServerPool", () => {
  it("shares one process across two acquires with the same key", async () => {
    const { deps } = fakeDeps();
    const pool = new OpenCodeServerPool(deps);
    const key = { binaryPath: "opencode", cwd: "/w/a", hostname: "127.0.0.1" };
    const first = await pool.acquire(key);
    const second = await pool.acquire(key);
    expect(first.baseUrl).toBe(second.baseUrl);
    expect(deps.spawn).toHaveBeenCalledTimes(1);
    expect(pool.size).toBe(1);
    await pool.shutdown();
  });

  it("isolates a second worktree on its own process", async () => {
    const { deps } = fakeDeps();
    const pool = new OpenCodeServerPool(deps);
    await pool.acquire({ binaryPath: "opencode", cwd: "/w/a", hostname: "127.0.0.1" });
    await pool.acquire({ binaryPath: "opencode", cwd: "/w/b", hostname: "127.0.0.1" });
    expect(deps.spawn).toHaveBeenCalledTimes(2);
    expect(pool.size).toBe(2);
    await pool.shutdown();
  });

  it("closes idle entries after the TTL with proven tree termination", async () => {
    const { deps, child } = fakeDeps();
    const pool = new OpenCodeServerPool(deps);
    const key = { binaryPath: "opencode", cwd: "/w/a", hostname: "127.0.0.1" };
    await pool.acquire(key);
    pool.release(key);
    const closed = await pool.closeIdle(1_000 + OPENCODE_POOL_IDLE_TTL_MS + 1);
    expect(closed).toHaveLength(1);
    expect(deps.terminateTree).toHaveBeenCalledWith(4242);
    expect(child.kill).not.toHaveBeenCalled();
    expect(pool.size).toBe(0);
    await pool.shutdown();
  });

  it("falls back to a direct kill when tree termination fails", async () => {
    const { deps, child } = fakeDeps({ terminateTree: vi.fn(async () => { throw new Error("taskkill failed"); }) });
    const pool = new OpenCodeServerPool(deps);
    const key = { binaryPath: "opencode", cwd: "/w/a", hostname: "127.0.0.1" };
    await pool.acquire(key);
    pool.release(key);
    await pool.closeIdle(1_000 + OPENCODE_POOL_IDLE_TTL_MS + 1);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(pool.size).toBe(0);
    await pool.shutdown();
  });

  it("cleans up without orphans when the child exits unexpectedly", async () => {
    const { deps, listeners, child } = fakeDeps();
    const pool = new OpenCodeServerPool(deps);
    const key = { binaryPath: "opencode", cwd: "/w/a", hostname: "127.0.0.1" };
    await pool.acquire(key);
    for (const listener of listeners.get("exit") ?? []) listener(null, null);
    expect(pool.size).toBe(0);
    expect(child.kill).not.toHaveBeenCalled();
    await pool.shutdown();
  });

  it("rejects the acquire when the child fails to spawn instead of crashing", async () => {
    const { deps, listeners } = fakeDeps({
      waitForHealth: vi.fn(async () => {
        for (const listener of listeners.get("error") ?? []) listener(new Error("spawn opencode ENOENT"));
      }),
    });
    const pool = new OpenCodeServerPool(deps);
    await expect(pool.acquire({ binaryPath: "opencode", cwd: "/w/a", hostname: "127.0.0.1" }))
      .rejects.toThrow("OpenCode serve failed to start");
    expect(pool.size).toBe(0);
    await pool.shutdown();
  });
});
