import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

const mockGetGitLog = vi.fn().mockResolvedValue([]);

vi.mock("@/transport", () => ({
  getTransport: () => ({ getGitLog: mockGetGitLog }),
}));

import { useHasCommitsAhead } from "./useHasCommitsAhead";

describe("useHasCommitsAhead", () => {
  beforeEach(() => {
    mockGetGitLog.mockReset().mockResolvedValue([]);
  });

  it("returns null when disabled (branch is null)", () => {
    const { result } = renderHook(() =>
      useHasCommitsAhead("ws-1", null),
    );
    expect(result.current).toBeNull();
    expect(mockGetGitLog).not.toHaveBeenCalled();
  });

  it("returns null when workspaceId is empty", () => {
    const { result } = renderHook(() =>
      useHasCommitsAhead("", "feat/my-branch"),
    );
    expect(result.current).toBeNull();
    expect(mockGetGitLog).not.toHaveBeenCalled();
  });

  it("returns false when branch has no commits ahead", async () => {
    mockGetGitLog.mockResolvedValue([]);

    const { result } = renderHook(() =>
      useHasCommitsAhead("ws-1", "feat/my-branch"),
    );

    await waitFor(() => {
      expect(result.current).toBe(false);
    });

    expect(mockGetGitLog).toHaveBeenCalledWith(
      "ws-1",
      "feat/my-branch",
      1,
      undefined,
      undefined,
    );
  });

  it("returns true when branch has commits ahead", async () => {
    mockGetGitLog.mockResolvedValue([
      { sha: "abc123", message: "feat: something", author: "user", date: "2026-01-01" },
    ]);

    const { result } = renderHook(() =>
      useHasCommitsAhead("ws-1", "feat/my-branch"),
    );

    await waitFor(() => {
      expect(result.current).toBe(true);
    });
  });

  it("re-polls on interval", async () => {
    vi.useFakeTimers();
    mockGetGitLog.mockImplementation(() => Promise.resolve([]));

    const { result } = renderHook(() =>
      useHasCommitsAhead("ws-1", "feat/my-branch"),
    );

    // Flush the initial fetch
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mockGetGitLog).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(false);

    // Advance past the polling interval (15s)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(mockGetGitLog).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it("resets when branch changes", async () => {
    mockGetGitLog.mockResolvedValue([
      { sha: "abc123", message: "feat: something", author: "user", date: "2026-01-01" },
    ]);

    const { result, rerender } = renderHook(
      ({ branch }) => useHasCommitsAhead("ws-1", branch),
      { initialProps: { branch: "feat/branch-a" } },
    );

    await waitFor(() => {
      expect(result.current).toBe(true);
    });

    // Switch to a branch with no commits ahead
    mockGetGitLog.mockResolvedValue([]);
    rerender({ branch: "feat/branch-b" });

    await waitFor(() => {
      expect(result.current).toBe(false);
    });
  });

  it("cleans up interval on unmount", async () => {
    vi.useFakeTimers();
    mockGetGitLog.mockImplementation(() => Promise.resolve([]));

    const { unmount } = renderHook(() =>
      useHasCommitsAhead("ws-1", "feat/my-branch"),
    );

    // Flush the initial fetch
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mockGetGitLog).toHaveBeenCalledTimes(1);

    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    // Should not have polled again after unmount
    expect(mockGetGitLog).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });
});
