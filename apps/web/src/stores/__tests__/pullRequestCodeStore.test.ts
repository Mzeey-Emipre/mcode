import type {
  PullRequestFile,
  PullRequestFilesResult,
  PullRequestIdentity,
  PullRequestPatchResult,
} from "@mcode/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PullRequestTransport } from "@/transport/pull-requests";
import {
  getPullRequestPatchKey,
  usePullRequestCodeStore,
} from "../pullRequestCodeStore";
import {
  selectPullRequestCodeCore,
  selectPullRequestCodeView,
} from "../pull-request-code-selectors";
import { usePullRequestReviewDraftStore } from "../pullRequestReviewDraftStore";

const IDENTITY: PullRequestIdentity = {
  provider: "github",
  repositoryNodeId: "REPO_1",
  owner: "Mzeey-Empire",
  repository: "mcode",
  number: 42,
};
const BASE_OID = "a".repeat(40);
const HEAD_OID = "b".repeat(40);
const FRESHNESS = {
  snapshotVersion: "files-v1",
  fetchedAt: "2026-07-11T12:00:00.000Z",
  staleAt: "2026-07-11T12:00:30.000Z",
};

function file(index: number): PullRequestFile {
  return {
    locator: `file_${index}`,
    path: `apps/web/src/file-${index}.ts`,
    previousPath: null,
    changeType: "modified",
    additions: 1,
    deletions: 1,
    changes: 2,
    blobOid: index.toString(16).padStart(40, "0"),
    patchStatus: "available",
  };
}

function filesResult(
  items: PullRequestFile[],
  nextCursor: string | null = null,
): PullRequestFilesResult {
  return {
    ok: true,
    items,
    nextCursor,
    baseOid: BASE_OID,
    headOid: HEAD_OID,
    boundedData: null,
    ...FRESHNESS,
  };
}

function patchResult(item: PullRequestFile, patch = "@@ -1 +1 @@\n-old\n+new"): PullRequestPatchResult {
  return {
    ok: true,
    status: "available",
    locator: item.locator,
    path: item.path,
    previousPath: item.previousPath,
    changeType: item.changeType,
    blobOid: item.blobOid,
    baseOid: BASE_OID,
    headOid: HEAD_OID,
    patch,
    parsedLineCount: patch.split("\n").length,
    fetchedAt: FRESHNESS.fetchedAt,
    staleAt: FRESHNESS.staleAt,
  };
}

function fakeTransport(
  overrides: Partial<PullRequestTransport> = {},
): PullRequestTransport {
  const base: PullRequestTransport = {
    getCapabilities: vi.fn().mockResolvedValue({ ok: false }),
    list: vi.fn().mockResolvedValue({ ok: false }),
    get: vi.fn().mockResolvedValue({ ok: false }),
    timeline: vi.fn().mockResolvedValue({ ok: false }),
    files: vi.fn().mockResolvedValue(filesResult([])),
    patch: vi.fn().mockResolvedValue({
      ok: false,
      error: { code: "remote_unavailable", message: "Unavailable" },
    }),
    cancel: vi.fn().mockResolvedValue({ ok: true, cancelled: true }),
  };
  return { ...base, ...overrides };
}

function activate(transport: PullRequestTransport, baseOid = BASE_OID, headOid = HEAD_OID) {
  return usePullRequestCodeStore.getState().activateSnapshot(
    {
      viewerNodeId: "VIEWER_1",
      identity: IDENTITY,
      baseOid,
      headOid,
    },
    transport,
  );
}

describe("pullRequestCodeStore", () => {
  beforeEach(() => {
    usePullRequestCodeStore.setState({
      entries: {},
      patches: {},
      activeSnapshotKey: null,
    });
    usePullRequestReviewDraftStore.getState().reset();
  });

  it("returns stable empty selector values before a snapshot is active", () => {
    const state = usePullRequestCodeStore.getState();
    const firstCore = selectPullRequestCodeCore(state);
    const secondCore = selectPullRequestCodeCore(state);
    const firstView = selectPullRequestCodeView(state);
    const secondView = selectPullRequestCodeView(state);

    expect(firstCore.files).toBe(secondCore.files);
    expect(firstView.expandedPaths).toBe(secondView.expandedPaths);
    expect(firstView.query).toBe(secondView.query);
  });

  it("coalesces one file page and sends the immutable base and head", async () => {
    let resolveFiles!: (result: PullRequestFilesResult) => void;
    const pending = new Promise<PullRequestFilesResult>((resolve) => {
      resolveFiles = resolve;
    });
    const files = vi.fn().mockReturnValue(pending);
    const transport = fakeTransport({ files });
    const snapshotKey = activate(transport);

    const first = usePullRequestCodeStore.getState().loadFiles({ transport });
    const second = usePullRequestCodeStore.getState().loadFiles({ transport });
    expect(files).toHaveBeenCalledOnce();
    expect(files).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: IDENTITY,
        baseOid: BASE_OID,
        headOid: HEAD_OID,
        limit: 100,
      }),
    );

    resolveFiles(filesResult([file(1)]));
    await Promise.all([first, second]);
    expect(usePullRequestCodeStore.getState().entries[snapshotKey]?.files).toEqual([
      file(1),
    ]);
  });

  it("expands only the first file from the initial page", async () => {
    const items = Array.from({ length: 25 }, (_, index) => file(index + 1));
    const transport = fakeTransport({
      files: vi.fn().mockResolvedValue(filesResult(items)),
    });
    const snapshotKey = activate(transport);

    await usePullRequestCodeStore.getState().loadFiles({ transport });

    const entry = usePullRequestCodeStore.getState().entries[snapshotKey];
    expect(entry?.activePath).toBe(file(1).path);
    expect(entry?.expandedPaths).toEqual({ [file(1).path]: true });
  });

  it("exhausts a filtered file search and marks it complete", async () => {
    const files = vi.fn().mockImplementation(async (request) => {
      if (!request.cursor) return filesResult([file(1)], "cursor-2");
      return filesResult([file(2)]);
    });
    const transport = fakeTransport({ files });
    const snapshotKey = activate(transport);
    usePullRequestCodeStore.getState().setFileQuery(
      { search: " store ", changeTypes: ["renamed", "modified", "modified"] },
      transport,
    );

    await usePullRequestCodeStore.getState().loadAllFiles(transport);

    const entry = usePullRequestCodeStore.getState().entries[snapshotKey];
    expect(entry?.files.map((item) => item.locator)).toEqual(["file_1", "file_2"]);
    expect(entry?.filesLane.complete).toBe(true);
    expect(files).toHaveBeenCalledTimes(2);
    expect(files).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        search: "store",
        changeTypes: ["modified", "renamed"],
      }),
    );
    expect(files).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: "cursor-2" }),
    );
  });

  it("continues a filtered search through a catch-up marker", async () => {
    const files = vi.fn().mockImplementation(async (request) => {
      if (!request.cursor) {
        return {
          ...filesResult([], "cursor-continued"),
          boundedData: { reason: "catch_up_limit" as const },
        };
      }
      return filesResult([file(2)]);
    });
    const transport = fakeTransport({ files });
    const snapshotKey = activate(transport);
    usePullRequestCodeStore.getState().setFileQuery(
      { search: "needle", changeTypes: [] },
      transport,
    );

    await usePullRequestCodeStore.getState().loadAllFiles(transport);

    const entry = usePullRequestCodeStore.getState().entries[snapshotKey];
    expect(files).toHaveBeenCalledTimes(2);
    expect(files).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: "cursor-continued" }),
    );
    expect(entry?.files.map((item) => item.locator)).toEqual(["file_2"]);
    expect(entry?.filesLane.complete).toBe(true);
    expect(entry?.filesLane.boundedData).toBeNull();
  });

  it("rejects a file page from a different base or head snapshot", async () => {
    const transport = fakeTransport({
      files: vi.fn().mockResolvedValue({
        ...filesResult([file(1)]),
        headOid: "c".repeat(40),
      }),
    });
    const snapshotKey = activate(transport);

    await usePullRequestCodeStore.getState().loadFiles({ transport });

    const entry = usePullRequestCodeStore.getState().entries[snapshotKey];
    expect(entry?.files).toEqual([]);
    expect(entry?.filesLane.error?.code).toBe("conflict");
  });

  it("coalesces each patch independently and reuses a ready immutable result", async () => {
    const patch = vi.fn().mockImplementation(async (request) => {
      const index = request.locator === "file_1" ? 1 : 2;
      return patchResult(file(index));
    });
    const transport = fakeTransport({ patch });
    activate(transport);
    const firstFile = file(1);
    const secondFile = file(2);

    await Promise.all([
      usePullRequestCodeStore.getState().ensurePatch(firstFile, transport),
      usePullRequestCodeStore.getState().ensurePatch(firstFile, transport),
      usePullRequestCodeStore.getState().ensurePatch(secondFile, transport),
    ]);
    await usePullRequestCodeStore.getState().ensurePatch(firstFile, transport);

    expect(patch).toHaveBeenCalledTimes(2);
    expect(patch.mock.calls.map(([request]) => request.locator).sort()).toEqual([
      "file_1",
      "file_2",
    ]);
  });

  it("turns a web-boundary line-count mismatch into too-large before rendering", async () => {
    const item = file(1);
    const transport = fakeTransport({
      patch: vi.fn().mockResolvedValue({
        ...patchResult(item),
        parsedLineCount: 1,
      }),
    });
    const snapshotKey = activate(transport);

    await usePullRequestCodeStore.getState().ensurePatch(item, transport);

    const patchKey = getPullRequestPatchKey(
      "VIEWER_1",
      IDENTITY,
      BASE_OID,
      HEAD_OID,
      item.locator,
    );
    const lane = usePullRequestCodeStore.getState().patches[patchKey];
    expect(lane?.snapshotKey).toBe(snapshotKey);
    expect(lane?.result).toMatchObject({
      status: "too_large",
      patch: null,
      parsedLineCount: null,
    });
    expect(lane?.rawBytes).toBe(0);
  });

  it("counts token caches in the 16 MiB LRU and evicts the oldest patch", async () => {
    const patch = vi.fn().mockImplementation(async (request) => {
      const index = Number(request.locator.split("_")[1]);
      return patchResult(file(index));
    });
    const transport = fakeTransport({ patch });
    activate(transport);

    for (let index = 1; index <= 6; index += 1) {
      const item = file(index);
      await usePullRequestCodeStore.getState().ensurePatch(item, transport);
      const patchKey = getPullRequestPatchKey(
        "VIEWER_1",
        IDENTITY,
        BASE_OID,
        HEAD_OID,
        item.locator,
      );
      expect(
        usePullRequestCodeStore
          .getState()
          .reportPatchDerivedBytes(patchKey, { tokenBytes: 3 * 1024 * 1024 }),
      ).toBe(true);
    }

    const state = usePullRequestCodeStore.getState();
    const total = Object.values(state.patches).reduce(
      (bytes, lane) => bytes + lane.estimatedBytes,
      0,
    );
    const firstKey = getPullRequestPatchKey(
      "VIEWER_1",
      IDENTITY,
      BASE_OID,
      HEAD_OID,
      file(1).locator,
    );
    expect(total).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(state.patches[firstKey]).toBeUndefined();
    expect(Object.keys(state.patches)).toHaveLength(5);
  });

  it("invalidates the same pull request on either OID change and marks drafts outdated", async () => {
    const transport = fakeTransport({
      patch: vi.fn().mockResolvedValue(patchResult(file(1))),
    });
    const firstSnapshotKey = activate(transport);
    const entry = usePullRequestCodeStore.getState().entries[firstSnapshotKey];
    expect(entry).toBeDefined();
    const draft = usePullRequestReviewDraftStore.getState().createDraft({
      snapshot: {
        identityKey: entry!.identityKey,
        baseOid: BASE_OID,
        headOid: HEAD_OID,
      },
      kind: "inline",
      path: file(1).path,
    });
    expect(draft.ok).toBe(true);
    await usePullRequestCodeStore.getState().ensurePatch(file(1), transport);

    const nextSnapshotKey = activate(transport, "c".repeat(40), HEAD_OID);

    const state = usePullRequestCodeStore.getState();
    expect(nextSnapshotKey).not.toBe(firstSnapshotKey);
    expect(state.entries[firstSnapshotKey]).toBeUndefined();
    expect(Object.keys(state.patches)).toHaveLength(0);
    if (draft.ok) {
      expect(
        usePullRequestReviewDraftStore.getState().drafts[draft.localId]?.outdated,
      ).toBe(true);
    }
  });
});
