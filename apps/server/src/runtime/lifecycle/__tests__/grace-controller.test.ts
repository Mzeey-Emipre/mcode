import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createGraceController } from "../grace-controller.js";

const GRACE_MS = 10_000;

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

  it("calls shutdown after grace period when idle and no clock jump", () => {
    let wallClock = 0;
    const shutdown = vi.fn();
    const sessionCount = vi.fn(() => 0);
    const isBusy = vi.fn(() => false);
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
    vi.advanceTimersByTime(GRACE_MS);

    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("keeps a supervised agent runtime alive after its browser disconnects", () => {
    let wallClock = 0;
    const shutdown = vi.fn();
    const ctrl = createGraceController({
      graceMs: GRACE_MS,
      sessionCount: vi.fn(() => 0),
      isBusy: vi.fn(() => false),
      shutdownOnIdle: false,
      shutdown,
      logger: makeLogger(),
      now: () => wallClock,
    });

    ctrl.handleSessionChange(0);
    wallClock += GRACE_MS;
    vi.advanceTimersByTime(GRACE_MS);

    expect(shutdown).not.toHaveBeenCalled();
  });

  it("cancels the timer when a session reconnects", () => {
    const shutdown = vi.fn();
    const ctrl = createGraceController({
      graceMs: GRACE_MS,
      sessionCount: vi.fn(() => 1),
      isBusy: vi.fn(() => false),
      shutdown,
      logger: makeLogger(),
    });

    ctrl.handleSessionChange(0); // arm
    ctrl.handleSessionChange(1); // cancel

    vi.advanceTimersByTime(GRACE_MS * 2);

    expect(shutdown).not.toHaveBeenCalled();
  });

  it("re-arms when busy on fire, then shuts down once idle", () => {
    let wallClock = 0;
    const shutdown = vi.fn();
    const sessionCount = vi.fn(() => 0);
    let busy = true;
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

    // First fire — server is busy; should re-arm, not shut down.
    wallClock += GRACE_MS;
    vi.advanceTimersByTime(GRACE_MS);
    expect(shutdown).not.toHaveBeenCalled();

    // Second fire — server is now idle.
    busy = false;
    wallClock += GRACE_MS;
    vi.advanceTimersByTime(GRACE_MS);
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("re-arms on clock jump (elapsed > graceMs * 2) instead of shutting down", () => {
    let wallClock = 0;
    const shutdown = vi.fn();
    const sessionCount = vi.fn(() => 0);
    const isBusy = vi.fn(() => false);
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
    vi.advanceTimersByTime(GRACE_MS); // JS timer fires

    // Should not shut down yet — re-armed for the full grace period.
    expect(shutdown).not.toHaveBeenCalled();

    // After re-arm, wall clock advances normally.
    wallClock += GRACE_MS;
    vi.advanceTimersByTime(GRACE_MS);

    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("does not shut down when sessions reconnect between arm and fire", () => {
    let sessions = 0;
    const shutdown = vi.fn();
    const ctrl = createGraceController({
      graceMs: GRACE_MS,
      sessionCount: () => sessions,
      isBusy: vi.fn(() => false),
      shutdown,
      logger: makeLogger(),
    });

    ctrl.handleSessionChange(0); // arm

    // A new session arrives before the timer fires.
    sessions = 1;

    vi.advanceTimersByTime(GRACE_MS);
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("dispose cancels a pending timer", () => {
    const shutdown = vi.fn();
    const ctrl = createGraceController({
      graceMs: GRACE_MS,
      sessionCount: vi.fn(() => 0),
      isBusy: vi.fn(() => false),
      shutdown,
      logger: makeLogger(),
    });

    ctrl.handleSessionChange(0); // arm
    ctrl.dispose();

    vi.advanceTimersByTime(GRACE_MS * 2);
    expect(shutdown).not.toHaveBeenCalled();
  });
});
