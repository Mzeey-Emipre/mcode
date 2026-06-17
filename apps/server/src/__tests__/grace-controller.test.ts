import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createGraceController, type BusyStatus } from "../grace-controller";

const GRACE_MS = 10_000;

/** Idle busy status — no agents, no busy terminals. */
const IDLE: BusyStatus = { agents: 0, terminals: 0 };

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

describe("createGraceController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls shutdown after grace period when idle and no clock jump", async () => {
    let wallClock = 0;
    const shutdown = vi.fn();
    const sessionCount = vi.fn(() => 0);
    const isBusy = vi.fn(() => IDLE);
    const now = () => wallClock;

    const ctrl = createGraceController({
      graceMs: GRACE_MS,
      sessionCount,
      isBusy,
      shutdown,
      logger: makeLogger(),
      now,
    });

    ctrl.handleSessionChange(0); // arm

    // Advance wall clock by exactly graceMs (within the 2x threshold).
    wallClock += GRACE_MS;
    await vi.advanceTimersByTimeAsync(GRACE_MS);

    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("cancels the timer when a session reconnects", async () => {
    const shutdown = vi.fn();
    const ctrl = createGraceController({
      graceMs: GRACE_MS,
      sessionCount: vi.fn(() => 1),
      isBusy: vi.fn(() => IDLE),
      shutdown,
      logger: makeLogger(),
    });

    ctrl.handleSessionChange(0); // arm
    ctrl.handleSessionChange(1); // cancel

    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);

    expect(shutdown).not.toHaveBeenCalled();
  });

  it("re-arms when busy on fire, then shuts down once idle", async () => {
    let wallClock = 0;
    const shutdown = vi.fn();
    const sessionCount = vi.fn(() => 0);
    let busy: BusyStatus = { agents: 0, terminals: 1 };
    const isBusy = vi.fn(() => busy);
    const now = () => wallClock;

    const ctrl = createGraceController({
      graceMs: GRACE_MS,
      sessionCount,
      isBusy,
      shutdown,
      logger: makeLogger(),
      now,
    });

    ctrl.handleSessionChange(0); // arm

    // First fire — a terminal command is running; should re-arm, not shut down.
    wallClock += GRACE_MS;
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(shutdown).not.toHaveBeenCalled();

    // Second fire — server is now idle.
    busy = IDLE;
    wallClock += GRACE_MS;
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("re-arms with an async busy probe, then shuts down once idle", async () => {
    let wallClock = 0;
    const shutdown = vi.fn();
    let busy: BusyStatus = { agents: 1, terminals: 0 };
    const isBusy = vi.fn(async () => busy);
    const now = () => wallClock;

    const ctrl = createGraceController({
      graceMs: GRACE_MS,
      sessionCount: () => 0,
      isBusy,
      shutdown,
      logger: makeLogger(),
      now,
    });

    ctrl.handleSessionChange(0); // arm

    wallClock += GRACE_MS;
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(shutdown).not.toHaveBeenCalled();

    busy = IDLE;
    wallClock += GRACE_MS;
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("re-arms instead of shutting down when the busy probe rejects", async () => {
    let wallClock = 0;
    const shutdown = vi.fn();
    const isBusy = vi.fn(async () => {
      throw new Error("process inspection failed");
    });
    const now = () => wallClock;

    const ctrl = createGraceController({
      graceMs: GRACE_MS,
      sessionCount: () => 0,
      isBusy,
      shutdown,
      logger: makeLogger(),
      now,
    });

    ctrl.handleSessionChange(0); // arm

    wallClock += GRACE_MS;
    await vi.advanceTimersByTimeAsync(GRACE_MS);

    // A failed probe must not interrupt potentially-running work.
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("re-arms on clock jump (elapsed > graceMs * 2) instead of shutting down", async () => {
    let wallClock = 0;
    const shutdown = vi.fn();
    const sessionCount = vi.fn(() => 0);
    const isBusy = vi.fn(() => IDLE);
    const now = () => wallClock;

    const ctrl = createGraceController({
      graceMs: GRACE_MS,
      sessionCount,
      isBusy,
      shutdown,
      logger: makeLogger(),
      now,
    });

    ctrl.handleSessionChange(0); // arm

    // Simulate machine sleeping: wall clock jumps far ahead while the JS
    // timer fires only slightly past graceMs.
    wallClock += GRACE_MS * 5; // large wall-clock jump
    await vi.advanceTimersByTimeAsync(GRACE_MS); // JS timer fires

    // Should not shut down yet — re-armed for the full grace period.
    expect(shutdown).not.toHaveBeenCalled();

    // After re-arm, wall clock advances normally.
    wallClock += GRACE_MS;
    await vi.advanceTimersByTimeAsync(GRACE_MS);

    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("does not shut down when sessions reconnect between arm and fire", async () => {
    let sessions = 0;
    const shutdown = vi.fn();
    const ctrl = createGraceController({
      graceMs: GRACE_MS,
      sessionCount: () => sessions,
      isBusy: vi.fn(() => IDLE),
      shutdown,
      logger: makeLogger(),
    });

    ctrl.handleSessionChange(0); // arm

    // A new session arrives before the timer fires.
    sessions = 1;

    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("dispose cancels a pending timer", async () => {
    const shutdown = vi.fn();
    const ctrl = createGraceController({
      graceMs: GRACE_MS,
      sessionCount: vi.fn(() => 0),
      isBusy: vi.fn(() => IDLE),
      shutdown,
      logger: makeLogger(),
    });

    ctrl.handleSessionChange(0); // arm
    ctrl.dispose();

    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
    expect(shutdown).not.toHaveBeenCalled();
  });
});
