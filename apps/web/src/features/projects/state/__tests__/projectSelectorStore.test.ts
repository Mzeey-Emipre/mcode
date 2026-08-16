import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  useProjectSelectorStore,
  type WorkspaceEnrichmentData,
} from "../projectSelectorStore";

/** Shape of the response resolved by the enrich() RPC stub. */
type EnrichResponse = { items: WorkspaceEnrichmentData[] };

beforeEach(() => {
  // Reset data without replace=true so the patched setState preserves the enrich action.
  useProjectSelectorStore.setState({ enrichmentCache: new Map(), pending: new Set() });
});

describe("projectSelectorStore", () => {
  it("enrich() merges results into the cache", async () => {
    const call = vi.fn().mockResolvedValue({
      items: [{ id: "1", branch: "main", isGit: true, isClean: true, threadCount: 2 }],
    });
    await useProjectSelectorStore.getState().enrich(["1"], call);
    expect(useProjectSelectorStore.getState().enrichmentCache.get("1")?.branch).toBe("main");
  });

  it("enrich() de-dupes ids already in cache", async () => {
    const call = vi.fn().mockResolvedValue({ items: [] });
    // Pre-populate cache
    useProjectSelectorStore.setState({
      enrichmentCache: new Map([["1", { id: "1", branch: "main", isGit: true, isClean: true, threadCount: 0 }]]),
    });
    await useProjectSelectorStore.getState().enrich(["1"], call);
    // Should not call because id is already cached
    expect(call).not.toHaveBeenCalled();
  });

  it("enrich() de-dupes concurrent calls for the same id", async () => {
    let resolve: (v: EnrichResponse) => void;
    const call = vi.fn().mockReturnValue(
      new Promise((r) => { resolve = r; })
    );
    const p1 = useProjectSelectorStore.getState().enrich(["1"], call);
    const p2 = useProjectSelectorStore.getState().enrich(["1"], call);
    resolve!({ items: [{ id: "1", branch: "feat", isGit: true, isClean: false, threadCount: 1 }] });
    await Promise.all([p1, p2]);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("enrich() is a no-op for empty array", async () => {
    const call = vi.fn();
    await useProjectSelectorStore.getState().enrich([], call);
    expect(call).not.toHaveBeenCalled();
  });
});
