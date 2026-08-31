import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockSpawn, mockWhich } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockWhich: vi.fn(),
}));

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, spawn: mockSpawn };
});

vi.mock("which", () => ({ default: mockWhich }));

import { warmCodexAppServer } from "../../private/codex/codex-app-server.js";

describe("warmCodexAppServer discovery budget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns uninitialized without spawning when executable discovery exhausts the budget", async () => {
    vi.useFakeTimers();
    let rejectDiscovery!: (reason?: unknown) => void;
    mockWhich.mockReturnValue(
      new Promise<string>((_resolve, reject) => {
        rejectDiscovery = reject;
      }),
    );

    const warmup = warmCodexAppServer("slow-codex", process.platform, 100);
    let settled = false;
    void warmup.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await vi.advanceTimersByTimeAsync(100);

    expect(settled).toBe(true);
    await expect(warmup).resolves.toEqual({ initialized: false });
    expect(mockSpawn).not.toHaveBeenCalled();

    rejectDiscovery(new Error("late discovery failure"));
    await Promise.resolve();
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
