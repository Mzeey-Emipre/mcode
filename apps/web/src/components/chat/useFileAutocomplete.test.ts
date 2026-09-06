import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderCatalogSnapshot } from "@mcode/contracts";

const listWorkspaceFiles = vi.fn<() => Promise<string[]>>();
const getProviderCatalog = vi.fn<() => Promise<ProviderCatalogSnapshot>>();

vi.mock("@/transport", () => ({
  getTransport: () => ({
    listWorkspaceFiles,
    getProviderCatalog,
  }),
}));

import {
  clearFileListCache,
  useFileAutocomplete,
} from "./useFileAutocomplete";
import {
  EMPTY_PROVIDER_CATALOG_CACHE_ENTRY,
  providerCatalogCacheKey,
  useProviderCatalogStore,
} from "@/stores/providerCatalogStore";

const REQUEST = { providerId: "codex" as const, workspaceId: "workspace-1" };
const CACHED_SNAPSHOT: ProviderCatalogSnapshot = {
  providerId: "codex",
  context: { scope: "workspace", workspaceId: "workspace-1" },
  freshness: { status: "stale", fetchedAt: "2026-07-20T12:00:00.000Z", reason: "Refreshing." },
  diagnostics: [],
  entries: [],
  selectableAgents: [{
    providerId: "codex",
    nativeId: "reviewer",
    name: "reviewer",
    path: "C:/agents/reviewer.toml",
    description: "Review changes",
  }],
};

const PLUGIN_ENTRY = {
  kind: "plugin" as const,
  identity: {
    providerId: "codex" as const,
    kind: "plugin" as const,
    nativeId: "browser@openai-bundled",
  },
  name: "Browser",
  description: "Control the in-app browser",
  mentionPath: "plugin://browser@openai-bundled",
  marketplaceName: "OpenAI",
  capabilities: ["browser"],
};

describe("useFileAutocomplete async lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearFileListCache();
    useProviderCatalogStore.getState().reset();
    listWorkspaceFiles.mockResolvedValue([]);
    getProviderCatalog.mockResolvedValue(CACHED_SNAPSHOT);
  });

  it("loads workspace catalog and files without a placeholder thread for @", async () => {
    listWorkspaceFiles.mockResolvedValueOnce(["src/app.ts"]);

    const { result } = renderHook(() => useFileAutocomplete({
      workspaceId: "workspace-1",
      providerId: "codex",
    }));

    await act(async () => {
      await result.current.handleInputChange("@", 1);
    });

    expect(getProviderCatalog).toHaveBeenCalledWith(REQUEST);
    expect(listWorkspaceFiles).toHaveBeenCalledWith("workspace-1", undefined);
    expect(result.current.suggestions).toContainEqual(expect.objectContaining({
      kind: "agent",
      name: "reviewer",
    }));
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

  it("refreshes an open picker after the scope cache is invalidated", async () => {
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
      await Promise.resolve();
    });

    expect(result.current.isOpen).toBe(true);
    expect(result.current.suggestions.map((item) => item.path)).toEqual([
      "src/new.ts",
    ]);
    expect(listWorkspaceFiles).toHaveBeenCalledTimes(2);
  });

  it("shows cached Codex agents before its picker reconciliation finishes", async () => {
    const key = providerCatalogCacheKey(REQUEST);
    useProviderCatalogStore.setState({
      entries: {
        [key]: {
          ...EMPTY_PROVIDER_CATALOG_CACHE_ENTRY,
          snapshot: CACHED_SNAPSHOT,
          needsRefresh: true,
        },
      },
    });
    let resolveCatalog!: (snapshot: ProviderCatalogSnapshot) => void;
    getProviderCatalog.mockReturnValueOnce(new Promise((resolve) => {
      resolveCatalog = resolve;
    }));
    const { result } = renderHook(() => useFileAutocomplete({
      workspaceId: "workspace-1",
      providerId: "codex",
    }));

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.handleInputChange("@", 1);
    });

    expect(result.current.suggestions).toContainEqual(expect.objectContaining({
      kind: "agent",
      name: "reviewer",
    }));
    expect(getProviderCatalog).toHaveBeenCalledWith(REQUEST);

    await act(async () => {
      resolveCatalog(CACHED_SNAPSHOT);
      await pending;
    });
  });

  it("reconciles changed agents while the mention picker remains open", async () => {
    const { result } = renderHook(() => useFileAutocomplete({
      workspaceId: "workspace-1",
      providerId: "codex",
    }));
    await act(async () => {
      await result.current.handleInputChange("@", 1);
    });

    act(() => {
      useProviderCatalogStore.getState().reconcile({
        request: REQUEST,
        additions: [],
        updates: [],
        removals: [],
        selectableAgents: {
          additions: [{
            providerId: "codex",
            nativeId: "scout",
            name: "scout",
            path: "C:/agents/scout.toml",
          }],
          updates: [],
          removals: [],
        },
      });
    });

    expect(result.current.isOpen).toBe(true);
    expect(result.current.suggestions.map((suggestion) => suggestion.label)).toEqual([
      "reviewer",
      "scout",
    ]);
  });

  it("exposes matching provider plugins in the mention picker", async () => {
    const pluginSnapshot = { ...CACHED_SNAPSHOT, entries: [PLUGIN_ENTRY] };
    getProviderCatalog.mockResolvedValueOnce(pluginSnapshot);
    const { result } = renderHook(() => useFileAutocomplete({
      workspaceId: "workspace-1",
      providerId: "codex",
    }));

    await act(async () => {
      await result.current.handleInputChange("@bro", 4);
    });

    expect(result.current.suggestions).toContainEqual({
      id: "plugin:codex:browser@openai-bundled",
      kind: "plugin",
      group: "Plugins",
      label: "Browser",
      name: "Browser",
      path: "plugin://browser@openai-bundled",
      description: "Control the in-app browser",
    });
  });

  it("fences a pending workspace refresh when the selected worktree cwd changes", async () => {
    let resolveWorkspaceCatalog!: (snapshot: ProviderCatalogSnapshot) => void;
    getProviderCatalog
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveWorkspaceCatalog = resolve;
      }))
      .mockResolvedValueOnce({
        ...CACHED_SNAPSHOT,
        context: { scope: "path", cwd: "C:/worktrees/feature" },
        selectableAgents: [{
          providerId: "codex",
          nativeId: "worktree-agent",
          name: "worktree-agent",
          path: "C:/worktrees/feature/.codex/agents/worktree-agent.toml",
        }],
      });
    const { result, rerender } = renderHook(
      ({ cwd }: { cwd?: string }) => useFileAutocomplete({
        workspaceId: "workspace-1",
        providerId: "codex",
        cwd,
      }),
      { initialProps: { cwd: undefined } as { cwd?: string } },
    );

    let pendingWorkspaceRefresh!: Promise<void>;
    act(() => {
      pendingWorkspaceRefresh = result.current.handleInputChange("@", 1);
    });
    expect(getProviderCatalog).toHaveBeenLastCalledWith(REQUEST);

    rerender({ cwd: "C:/worktrees/feature" });
    await act(async () => {
      await result.current.handleInputChange("@", 1);
    });

    expect(getProviderCatalog).toHaveBeenLastCalledWith({
      providerId: "codex",
      cwd: "C:/worktrees/feature",
    });
    expect(result.current.suggestions).toContainEqual(expect.objectContaining({
      name: "worktree-agent",
    }));

    await act(async () => {
      resolveWorkspaceCatalog(CACHED_SNAPSHOT);
      await pendingWorkspaceRefresh;
    });
    expect(result.current.suggestions).toContainEqual(expect.objectContaining({
      name: "worktree-agent",
    }));
    expect(result.current.suggestions).not.toContainEqual(expect.objectContaining({
      name: "reviewer",
    }));
  });
});
