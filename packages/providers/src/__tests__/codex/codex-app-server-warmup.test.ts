import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boundaries = vi.hoisted(() => ({
  spawn: vi.fn(),
  which: vi.fn(),
}));

vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof import("child_process")>("child_process");
  return { ...actual, spawn: boundaries.spawn };
});

vi.mock("which", () => ({ default: boundaries.which }));

import { warmCodexAppServer } from "../../private/codex/codex-app-server.js";

describe("warmCodexAppServer", () => {
  beforeEach(() => {
    boundaries.spawn.mockReset();
    boundaries.which.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves an uninitialized result for a missing binary without throwing", async () => {
    boundaries.which.mockRejectedValue(new Error("missing"));

    await expect(
      warmCodexAppServer("definitely-not-a-real-binary-xyz", process.platform, 100),
    ).resolves.toEqual({ initialized: false });
    expect(boundaries.spawn).not.toHaveBeenCalled();
  });

  it("bounds executable discovery inside the warmup deadline", async () => {
    vi.useFakeTimers();
    boundaries.which.mockReturnValue(new Promise(() => undefined));

    const result = warmCodexAppServer("slow-codex", process.platform, 100);
    await vi.advanceTimersByTimeAsync(100);

    await expect(result).resolves.toEqual({ initialized: false });
    expect(boundaries.spawn).not.toHaveBeenCalled();
  });
});
