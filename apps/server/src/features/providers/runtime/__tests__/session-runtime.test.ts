import "reflect-metadata";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SessionRuntime } from "../session-runtime";
import type { ProtocolAdapter, SpawnArgs, SpawnResult } from "../session-runtime";

/** Per-session state for the fake adapter. */
interface FakeState {
  id: string;
  cwd: string;
  permissionMode: string;
  busy: boolean;
  dead: boolean;
}

/** Records every adapter call so tests can assert on lifecycle ordering. */
class FakeAdapter implements ProtocolAdapter<FakeState> {
  calls: string[] = [];
  spawnEnvs: Array<Record<string, string>> = [];
  nextPids: number[] = [];

  async spawn(args: SpawnArgs): Promise<SpawnResult<FakeState>> {
    this.calls.push(`spawn:${args.sessionId}`);
    this.spawnEnvs.push(args.env);
    return {
      state: { id: args.sessionId, cwd: args.cwd, permissionMode: args.permissionMode, busy: false, dead: false },
      pids: this.nextPids,
    };
  }
  isBusy(state: FakeState): boolean {
    return state.busy;
  }
  interrupt(state: FakeState): void {
    this.calls.push(`interrupt:${state.id}`);
  }
  close(state: FakeState): void {
    this.calls.push(`close:${state.id}`);
  }
  isStale(state: FakeState, args: { cwd: string; permissionMode: string }): boolean {
    return state.dead || state.cwd !== args.cwd || state.permissionMode !== args.permissionMode;
  }
}

const jobObject = { isWindowsJob: false, assign: vi.fn(), setDescription: vi.fn() } as unknown as import("../../../../runtime/process/containment/job-object").JobObject;
const envService = { getEnv: () => ({ MCODE_TEST: "1" }) } as unknown as import("../../../../runtime/environment/env-service").EnvService;

function makeRuntime(adapter: FakeAdapter, idleTtlMs = 1000): SessionRuntime<FakeState> {
  return new SessionRuntime<FakeState>(adapter, { jobObject, envService, idleTtlMs });
}

const ACQUIRE = { sessionId: "s1", threadId: "t1", cwd: "/repo", permissionMode: "full" };

describe("SessionRuntime", () => {
  let adapter: FakeAdapter;

  beforeEach(() => {
    adapter = new FakeAdapter();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("spawns lazily on first acquire and reuses the pooled session on the second", async () => {
    const rt = makeRuntime(adapter);
    const a = await rt.acquire(ACQUIRE);
    const b = await rt.acquire(ACQUIRE);
    expect(a).toBe(b);
    expect(adapter.calls.filter((c) => c.startsWith("spawn")).length).toBe(1);
    expect(rt.size).toBe(1);
  });

  it("passes the EnvService-snapshotted env to spawn", async () => {
    const rt = makeRuntime(adapter);
    await rt.acquire(ACQUIRE);
    expect(adapter.spawnEnvs[0]).toEqual({ MCODE_TEST: "1" });
  });

  it("discards a stale session and respawns before reuse", async () => {
    const rt = makeRuntime(adapter);
    const first = await rt.acquire(ACQUIRE);
    first.dead = true; // simulate a dead process
    const second = await rt.acquire(ACQUIRE);
    expect(second).not.toBe(first);
    expect(adapter.calls).toEqual([
      "spawn:s1",
      "interrupt:s1", // stop() of the stale session
      "close:s1",
      "spawn:s1",
    ]);
  });

  it("evicts an idle, non-busy session after the TTL", async () => {
    const rt = makeRuntime(adapter, 1000);
    await rt.acquire(ACQUIRE);
    await vi.advanceTimersByTimeAsync(1001 + 60_000); // past TTL, next sweep
    expect(rt.size).toBe(0);
    expect(adapter.calls).toContain("close:s1");
  });

  it("never evicts a busy session even past the TTL (converged busy guard)", async () => {
    const rt = makeRuntime(adapter, 1000);
    const state = await rt.acquire(ACQUIRE);
    state.busy = true;
    await vi.advanceTimersByTimeAsync(1001 + 60_000 * 3); // several sweeps
    expect(rt.size).toBe(1); // survived because isBusy() is true
  });

  it("evicts non-busy sessions under memory pressure and preserves busy sessions", async () => {
    const rt = makeRuntime(adapter);
    await rt.acquire({ ...ACQUIRE, sessionId: "idle" });
    const busy = await rt.acquire({ ...ACQUIRE, sessionId: "busy" });
    busy.busy = true;

    const result = await rt.evictNonBusy("test-pressure");

    expect(result).toEqual({ before: 2, after: 1, evicted: ["idle"] });
    expect(rt.size).toBe(1);
    expect(adapter.calls).toContain("close:idle");
    expect(adapter.calls).not.toContain("close:busy");
  });

  it("stop() runs interrupt then close in order", async () => {
    const rt = makeRuntime(adapter);
    await rt.acquire(ACQUIRE);
    await rt.stop("s1");
    expect(adapter.calls).toEqual(["spawn:s1", "interrupt:s1", "close:s1"]);
    expect(rt.size).toBe(0);
  });

  it("dedups concurrent acquire() for the same session into a single spawn", async () => {
    // A slow adapter whose spawn does not resolve until we release it, so both
    // acquire() calls are genuinely in flight at the same time.
    let releaseSpawn!: () => void;
    const spawnGate = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    let spawnCount = 0;
    const slowAdapter: ProtocolAdapter<FakeState> = {
      async spawn(args: SpawnArgs): Promise<SpawnResult<FakeState>> {
        spawnCount++;
        await spawnGate;
        return {
          state: { id: args.sessionId, cwd: args.cwd, permissionMode: args.permissionMode, busy: false, dead: false },
          pids: [],
        };
      },
      isBusy: () => false,
      interrupt: () => {},
      close: () => {},
      isStale: () => false,
    };
    const rt = makeRuntime(slowAdapter as FakeAdapter);

    const p1 = rt.acquire({ ...ACQUIRE, sessionId: "s" });
    const p2 = rt.acquire({ ...ACQUIRE, sessionId: "s" });
    releaseSpawn();
    const [a, b] = await Promise.all([p1, p2]);

    expect(spawnCount).toBe(1);
    expect(a).toBe(b);
    expect(rt.size).toBe(1);
  });

  it("closes a session that finishes spawning after stop", async () => {
    let releaseSpawn!: () => void;
    const spawnGate = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    const slowAdapter = new FakeAdapter();
    slowAdapter.spawn = async (args: SpawnArgs): Promise<SpawnResult<FakeState>> => {
      slowAdapter.calls.push(`spawn:${args.sessionId}`);
      await spawnGate;
      return {
        state: { id: args.sessionId, cwd: args.cwd, permissionMode: args.permissionMode, busy: false, dead: false },
        pids: [],
      };
    };
    const rt = makeRuntime(slowAdapter);

    const acquire = rt.acquire(ACQUIRE);
    const stop = rt.stop(ACQUIRE.sessionId);
    releaseSpawn();

    await expect(acquire).rejects.toThrow("stopped during spawn");
    await stop;
    expect(rt.size).toBe(0);
    expect(slowAdapter.calls).toEqual(["spawn:s1", "interrupt:s1", "close:s1"]);
  });

  it("shutdown() stops all sessions and clears the eviction timer", async () => {
    const rt = makeRuntime(adapter);
    await rt.acquire({ ...ACQUIRE, sessionId: "s1" });
    await rt.acquire({ ...ACQUIRE, sessionId: "s2" });
    await rt.shutdown();
    expect(rt.size).toBe(0);
    expect(adapter.calls.filter((c) => c.startsWith("close")).sort()).toEqual(["close:s1", "close:s2"]);
    // Timer cleared: advancing time triggers no further sweeps/spawns.
    const before = adapter.calls.length;
    await vi.advanceTimersByTimeAsync(60_000 * 5);
    expect(adapter.calls.length).toBe(before);
  });
});
