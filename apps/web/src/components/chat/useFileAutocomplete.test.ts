import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listWorkspaceFiles = vi.fn<() => Promise<string[]>>();

vi.mock("@/transport", () => ({
  getTransport: () => ({
    listWorkspaceFiles,
    listCodexAgents: vi.fn().mockResolvedValue([]),
  }),
}));

import {
  clearFileListCache,
  useFileAutocomplete,
} from "./useFileAutocomplete";

describe("useFileAutocomplete async lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearFileListCache();
  });

  it("does not reopen after the user dismisses while files are loading", async () => {
    let resolveFiles!: (files: string[]) => void;
    listWorkspaceFiles.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFiles = resolve;
      }),
    );

    const { result } = renderHook(() =>
      useFileAutocomplete({ workspaceId: "workspace-1" }),
    );

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.handleInputChange("@", 1) as unknown as Promise<void>;
    });
    act(() => {
      result.current.dismiss();
    });

    await act(async () => {
      resolveFiles(["src/app.ts"]);
      await pending;
    });

    expect(result.current.isOpen).toBe(false);
    expect(result.current.suggestions).toEqual([]);
  });

  it("reloads mounted suggestions after the scope cache is invalidated", async () => {
    listWorkspaceFiles
      .mockResolvedValueOnce(["src/old.ts"])
      .mockResolvedValueOnce(["src/new.ts"]);
    const { result } = renderHook(() =>
      useFileAutocomplete({ workspaceId: "workspace-1" }),
    );

    await act(async () => {
      await result.current.handleInputChange("@", 1);
    });
    expect(result.current.suggestions.map((item) => item.path)).toContain(
      "src/old.ts",
    );

    act(() => {
      clearFileListCache("workspace-1");
    });
    await act(async () => {
      await result.current.handleInputChange("@", 1);
    });

    expect(result.current.suggestions.map((item) => item.path)).toEqual([
      "src/new.ts",
    ]);
    expect(listWorkspaceFiles).toHaveBeenCalledTimes(2);
  });
});
