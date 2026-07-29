import { describe, expect, it, vi } from "vitest";
import {
  createAdjacentPrefetchScheduler,
  type AdjacentPrefetchThread,
} from "../adjacent-prefetch";
import { enqueueBackgroundPrefetch } from "../prefetch-scheduler";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function thread(id: string, overrides: Partial<AdjacentPrefetchThread> = {}) {
  return { id, ...overrides };
}

describe("adjacent prefetch scheduler", () => {
  it("warms only the previous and next eligible neighbors", async () => {
    const prefetch = vi.fn().mockResolvedValue(undefined);
    const scheduler = createAdjacentPrefetchScheduler({ prefetch });

    scheduler.activate("t2", [
      thread("t1"),
      thread("t2"),
      thread("preparing", { clientPreparing: true }),
      thread("t4"),
    ]);
    await Promise.resolve();

    expect(prefetch).toHaveBeenCalledTimes(2);
    expect(prefetch).toHaveBeenNthCalledWith(1, "t1");
    expect(prefetch).toHaveBeenNthCalledWith(2, "t4");
  });

  it("does nothing for an unknown selection or unavailable neighbors", () => {
    const prefetch = vi.fn().mockResolvedValue(undefined);
    const scheduler = createAdjacentPrefetchScheduler({ prefetch });

    scheduler.activate("missing", [thread("t1")]);
    scheduler.activate("t2", [
      thread("t1", { clientError: "failed" }),
      thread("t2"),
      thread("t3", { clientPreparing: true }),
    ]);

    expect(prefetch).not.toHaveBeenCalled();
  });

  it("cancels queued work from the previous activation while in-flight work settles", async () => {
    const first = deferred();
    const second = deferred();
    const prefetch = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
      .mockResolvedValue(undefined);
    const scheduler = createAdjacentPrefetchScheduler({ prefetch });

    scheduler.activate("t2", [thread("t1"), thread("t2"), thread("t3")]);
    scheduler.activate("t3", [thread("t1"), thread("t2"), thread("t3"), thread("t4")]);
    scheduler.activate("t1", [thread("t1"), thread("t2"), thread("t3"), thread("t4")]);
    expect(prefetch.mock.calls.map(([id]) => id)).toEqual(["t1", "t3"]);
    first.resolve();
    second.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(prefetch.mock.calls.map(([id]) => id)).toEqual(["t1", "t3", "t2"]);
  });

  it("releases a slot when an old request settles", async () => {
    const first = deferred();
    const second = deferred();
    const third = deferred();
    const fourth = deferred();
    const prefetch = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
      .mockImplementationOnce(() => third.promise)
      .mockImplementationOnce(() => fourth.promise);
    const scheduler = createAdjacentPrefetchScheduler({ prefetch });

    scheduler.activate("t2", [thread("t1"), thread("t2"), thread("t3")]);
    first.resolve();
    await Promise.resolve();
    await Promise.resolve();
    scheduler.activate("t3", [thread("t1"), thread("t2"), thread("t3"), thread("t4")]);
    expect(prefetch.mock.calls.map(([id]) => id)).toEqual(["t1", "t3", "t2"]);

    second.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(prefetch.mock.calls.map(([id]) => id)).toEqual(["t1", "t3", "t2", "t4"]);

    third.resolve();
    fourth.resolve();
  });

  it("shares its two slots with pointer and hover prefetch work", async () => {
    const hover = deferred();
    const firstAdjacent = deferred();
    const secondAdjacent = deferred();
    const prefetch = vi
      .fn()
      .mockImplementationOnce(() => firstAdjacent.promise)
      .mockImplementationOnce(() => secondAdjacent.promise);
    enqueueBackgroundPrefetch("hover", () => hover.promise);
    const scheduler = createAdjacentPrefetchScheduler({ prefetch });

    scheduler.activate("t2", [thread("t1"), thread("t2"), thread("t3")]);
    expect(prefetch).toHaveBeenCalledTimes(1);
    expect(prefetch).toHaveBeenCalledWith("t1");

    hover.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(prefetch).toHaveBeenCalledTimes(2);
    expect(prefetch).toHaveBeenLastCalledWith("t3");

    firstAdjacent.resolve();
    secondAdjacent.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
});
