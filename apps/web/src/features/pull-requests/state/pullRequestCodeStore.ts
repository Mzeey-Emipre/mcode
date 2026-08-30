import type {
  PullRequestBoundedDataMarker,
  PullRequestError,
  PullRequestFile,
  PullRequestFileChangeType,
  PullRequestIdentity,
  PullRequestPatchResult,
} from "@mcode/contracts";
import {
  PULL_REQUEST_FILE_MAX_COUNT,
  PULL_REQUEST_PATCH_MAX_BYTES,
  PULL_REQUEST_PATCH_MAX_LINES,
  PULL_REQUEST_PATCH_MAX_LINE_LENGTH,
} from "@mcode/contracts";
import { create } from "zustand";
import {
  getPullRequestTransport,
  type PullRequestTransport,
} from "@/transport/pull-requests";
import { usePullRequestReviewDraftStore } from "./pullRequestReviewDraftStore";

const FILE_PAGE_SIZE = 100;
const MAX_CODE_SNAPSHOTS = 25;

/** Maximum raw, parsed, and token bytes retained for pull request Code. */
export const PULL_REQUEST_CODE_CACHE_MAX_BYTES = 16 * 1024 * 1024;

/** Status for one independently cancellable Code read lane. */
export type PullRequestCodeLaneStatus =
  | "idle"
  | "loading"
  | "ready"
  | "error";

/** Unified or split presentation selected for pull request patches. */
export type PullRequestCodeViewMode = "unified" | "split";

/** Server-side filter applied to one changed-file snapshot. */
export interface PullRequestFileQuery {
  search: string;
  changeTypes: PullRequestFileChangeType[];
}

/** Cancellable changed-file paging state for one immutable snapshot. */
export interface PullRequestFilesLaneState {
  status: PullRequestCodeLaneStatus;
  operationId: string | null;
  generation: number;
  error: PullRequestError | null;
  nextCursor: string | null;
  fetchedAt: number | null;
  staleAt: number | null;
  boundedData: PullRequestBoundedDataMarker | null;
  complete: boolean;
  partialReason: "bounded" | "cursor_stalled" | null;
}

/** One viewer-qualified, base-and-head-qualified Code snapshot. */
export interface PullRequestCodeEntry {
  viewerNodeId: string;
  identity: PullRequestIdentity;
  identityKey: string;
  snapshotKey: string;
  baseOid: string;
  headOid: string;
  query: PullRequestFileQuery;
  files: PullRequestFile[];
  filesLane: PullRequestFilesLaneState;
  expandedPaths: Record<string, true>;
  activePath: string | null;
  viewMode: PullRequestCodeViewMode;
  fileTreeVisible: boolean;
  lastAccessedAt: number;
}

/** Successful immutable patch result retained by the web LRU. */
export type PullRequestPatchSuccess = Extract<PullRequestPatchResult, { ok: true }>;

/** Independent read and memory-accounting lane for one immutable file patch. */
export interface PullRequestPatchLaneState {
  patchKey: string;
  snapshotKey: string;
  locator: string;
  path: string;
  blobOid: string;
  status: PullRequestCodeLaneStatus;
  operationId: string | null;
  generation: number;
  error: PullRequestError | null;
  result: PullRequestPatchSuccess | null;
  rawBytes: number;
  parsedBytes: number;
  tokenBytes: number;
  estimatedBytes: number;
  lastAccessedAt: number;
}

/** Input used to activate one immutable pull request Code snapshot. */
export interface ActivatePullRequestCodeSnapshotInput {
  viewerNodeId: string;
  identity: PullRequestIdentity;
  baseOid: string;
  headOid: string;
}

/** Options for loading one changed-file page. */
export interface PullRequestFilesLoadOptions {
  append?: boolean;
  transport?: PullRequestTransport;
}

/** Absolute derived-cache sizes reported by the virtual diff renderer. */
export interface PullRequestPatchDerivedBytes {
  parsedBytes?: number;
  tokenBytes?: number;
}

/** Public state and actions for pull request Code reads. */
export interface PullRequestCodeStoreState {
  entries: Record<string, PullRequestCodeEntry>;
  patches: Record<string, PullRequestPatchLaneState>;
  activeSnapshotKey: string | null;
  patchPresentationRevision: number;
  activateSnapshot: (
    input: ActivatePullRequestCodeSnapshotInput,
    transport?: PullRequestTransport,
  ) => string;
  setFileQuery: (
    query: PullRequestFileQuery,
    transport?: PullRequestTransport,
  ) => void;
  loadFiles: (options?: PullRequestFilesLoadOptions) => Promise<void>;
  loadAllFiles: (transport?: PullRequestTransport) => Promise<void>;
  ensurePatch: (
    file: PullRequestFile,
    transport?: PullRequestTransport,
  ) => Promise<void>;
  reportPatchDerivedBytes: (
    patchKey: string,
    bytes: PullRequestPatchDerivedBytes,
  ) => boolean;
  clearPatchDerivedBytes: (patchKey: string) => void;
  touchPatch: (patchKey: string) => void;
  toggleFileExpanded: (path: string) => void;
  expandAll: (paths: readonly string[]) => void;
  collapseAll: () => void;
  setActivePath: (path: string | null) => void;
  setViewMode: (mode: PullRequestCodeViewMode) => void;
  setFileTreeVisible: (visible: boolean) => void;
  /** Invalidate remote Code data for one identity while preserving its view choices. */
  invalidateAfterMutation: (
    identity: PullRequestIdentity,
    transport?: PullRequestTransport,
  ) => Promise<void>;
  cancelActive: (transport?: PullRequestTransport) => Promise<void>;
  reset: (transport?: PullRequestTransport) => void;
}

interface StartedFilesLane {
  snapshotKey: string;
  operationId: string;
  generation: number;
  cursor: string | null;
  append: boolean;
  query: PullRequestFileQuery;
}

interface StartedPatchLane {
  patchKey: string;
  snapshotKey: string;
  operationId: string;
  generation: number;
  file: PullRequestFile;
}

const textEncoder = new TextEncoder();
const filePromises = new Map<string, Promise<void>>();
const patchPromises = new Map<string, Promise<void>>();
let operationSequence = 0;
let accessSequence = 0;

function nextAccess(): number {
  accessSequence += 1;
  return accessSequence;
}

function nextOperationId(lane: "files" | "patch"): string {
  operationSequence += 1;
  return `pr-code-${lane}-${Date.now().toString(36)}-${operationSequence.toString(36)}`;
}

function identityKey(identity: PullRequestIdentity): string {
  return JSON.stringify([
    identity.provider,
    identity.repositoryNodeId,
    identity.number,
  ]);
}

/** Return the collision-safe key for a viewer-qualified immutable Code snapshot. */
export function getPullRequestCodeSnapshotKey(
  viewerNodeId: string,
  identity: PullRequestIdentity,
  baseOid: string,
  headOid: string,
): string {
  return JSON.stringify([
    viewerNodeId,
    identity.provider,
    identity.repositoryNodeId,
    identity.number,
    baseOid,
    headOid,
  ]);
}

/** Return the collision-safe key for one immutable file patch. */
export function getPullRequestPatchKey(
  viewerNodeId: string,
  identity: PullRequestIdentity,
  baseOid: string,
  headOid: string,
  locator: string,
): string {
  return JSON.stringify([
    viewerNodeId,
    identity.provider,
    identity.repositoryNodeId,
    identity.number,
    baseOid,
    headOid,
    locator,
  ]);
}

function emptyFilesLane(generation = 0): PullRequestFilesLaneState {
  return {
    status: "idle",
    operationId: null,
    generation,
    error: null,
    nextCursor: null,
    fetchedAt: null,
    staleAt: null,
    boundedData: null,
    complete: false,
    partialReason: null,
  };
}

function normalizeQuery(query: PullRequestFileQuery): PullRequestFileQuery {
  const allowed = new Set<PullRequestFileChangeType>([
    "added",
    "modified",
    "deleted",
    "renamed",
    "copied",
    "changed",
    "unchanged",
  ]);
  return {
    search: query.search.trim().slice(0, 200),
    changeTypes: [...new Set(query.changeTypes.filter((item) => allowed.has(item)))].sort(),
  };
}

function queriesMatch(
  left: PullRequestFileQuery,
  right: PullRequestFileQuery,
): boolean {
  return (
    left.search === right.search &&
    left.changeTypes.length === right.changeTypes.length &&
    left.changeTypes.every((item, index) => item === right.changeTypes[index])
  );
}

function createEntry(input: ActivatePullRequestCodeSnapshotInput): PullRequestCodeEntry {
  const key = getPullRequestCodeSnapshotKey(
    input.viewerNodeId,
    input.identity,
    input.baseOid,
    input.headOid,
  );
  return {
    viewerNodeId: input.viewerNodeId,
    identity: input.identity,
    identityKey: identityKey(input.identity),
    snapshotKey: key,
    baseOid: input.baseOid,
    headOid: input.headOid,
    query: { search: "", changeTypes: [] },
    files: [],
    filesLane: emptyFilesLane(),
    expandedPaths: {},
    activePath: null,
    viewMode: "unified",
    fileTreeVisible: true,
    lastAccessedAt: nextAccess(),
  };
}

function normalizeError(error: unknown): PullRequestError {
  return {
    code: "remote_unavailable",
    message:
      error instanceof Error
        ? error.message.slice(0, 512)
        : "Pull request Code data is unavailable.",
  };
}

function activeOperationIds(
  entry: PullRequestCodeEntry | undefined,
  patches: Record<string, PullRequestPatchLaneState>,
): string[] {
  if (!entry) return [];
  const ids = entry.filesLane.operationId ? [entry.filesLane.operationId] : [];
  for (const patch of Object.values(patches)) {
    if (patch.snapshotKey === entry.snapshotKey && patch.operationId) {
      ids.push(patch.operationId);
    }
  }
  return ids;
}

async function cancelOperationIds(
  operationIds: readonly string[],
  transport: PullRequestTransport,
): Promise<void> {
  await Promise.all(
    [...new Set(operationIds)].map(async (operationId) => {
      try {
        await transport.cancel({ operationId });
      } catch {
        // A local snapshot switch must finish even when cancellation races disconnect.
      }
    }),
  );
}

function clearSnapshotOperations(
  entry: PullRequestCodeEntry,
  patches: Record<string, PullRequestPatchLaneState>,
): {
  entry: PullRequestCodeEntry;
  patches: Record<string, PullRequestPatchLaneState>;
} {
  const nextPatches = { ...patches };
  for (const [patchKey, patch] of Object.entries(nextPatches)) {
    if (patch.snapshotKey !== entry.snapshotKey || !patch.operationId) continue;
    nextPatches[patchKey] = {
      ...patch,
      status: patch.result ? "ready" : "idle",
      operationId: null,
      generation: patch.generation + 1,
    };
  }
  return {
    entry: {
      ...entry,
      filesLane: {
        ...entry.filesLane,
        status: entry.filesLane.fetchedAt === null ? "idle" : "ready",
        operationId: null,
        generation:
          entry.filesLane.generation + (entry.filesLane.operationId ? 1 : 0),
      },
    },
    patches: nextPatches,
  };
}

function evictSnapshots(
  entries: Record<string, PullRequestCodeEntry>,
  patches: Record<string, PullRequestPatchLaneState>,
  protectedKey: string,
): {
  entries: Record<string, PullRequestCodeEntry>;
  patches: Record<string, PullRequestPatchLaneState>;
  operationIds: string[];
} {
  const nextEntries = { ...entries };
  const nextPatches = { ...patches };
  const operationIds: string[] = [];
  while (Object.keys(nextEntries).length > MAX_CODE_SNAPSHOTS) {
    const oldest = Object.values(nextEntries)
      .filter((entry) => entry.snapshotKey !== protectedKey)
      .sort((left, right) => left.lastAccessedAt - right.lastAccessedAt)[0];
    if (!oldest) break;
    operationIds.push(...activeOperationIds(oldest, nextPatches));
    delete nextEntries[oldest.snapshotKey];
    for (const [patchKey, patch] of Object.entries(nextPatches)) {
      if (patch.snapshotKey === oldest.snapshotKey) delete nextPatches[patchKey];
    }
  }
  return { entries: nextEntries, patches: nextPatches, operationIds };
}

function patchCacheBytes(
  patches: Record<string, PullRequestPatchLaneState>,
): number {
  return Object.values(patches).reduce(
    (total, patch) => total + patch.estimatedBytes,
    0,
  );
}

function evictPatchLru(
  patches: Record<string, PullRequestPatchLaneState>,
  protectedKey: string,
): Record<string, PullRequestPatchLaneState> {
  const next = { ...patches };
  while (patchCacheBytes(next) > PULL_REQUEST_CODE_CACHE_MAX_BYTES) {
    const oldest = Object.values(next)
      .filter(
        (patch) =>
          patch.patchKey !== protectedKey && patch.operationId === null,
      )
      .sort((left, right) => left.lastAccessedAt - right.lastAccessedAt)[0];
    if (!oldest) break;
    delete next[oldest.patchKey];
  }
  return next;
}

function beginFilesLane(append: boolean): StartedFilesLane | null {
  const state = usePullRequestCodeStore.getState();
  const snapshotKey = state.activeSnapshotKey;
  const entry = snapshotKey ? state.entries[snapshotKey] : undefined;
  if (!snapshotKey || !entry || entry.filesLane.operationId) return null;
  const cursor = append ? entry.filesLane.nextCursor : null;
  if (append && !cursor) return null;
  const operationId = nextOperationId("files");
  const generation = entry.filesLane.generation + 1;
  usePullRequestCodeStore.setState({
    entries: {
      ...state.entries,
      [snapshotKey]: {
        ...entry,
        lastAccessedAt: nextAccess(),
        filesLane: {
          ...entry.filesLane,
          status: "loading",
          operationId,
          generation,
          error: null,
          partialReason: null,
        },
      },
    },
  });
  return {
    snapshotKey,
    operationId,
    generation,
    cursor,
    append,
    query: entry.query,
  };
}

function ownedFilesEntry(started: StartedFilesLane): PullRequestCodeEntry | null {
  const state = usePullRequestCodeStore.getState();
  const entry = state.entries[started.snapshotKey];
  if (
    !entry ||
    entry.filesLane.operationId !== started.operationId ||
    entry.filesLane.generation !== started.generation ||
    !queriesMatch(entry.query, started.query)
  ) {
    return null;
  }
  return entry;
}

function failFilesLane(started: StartedFilesLane, error: PullRequestError): void {
  const state = usePullRequestCodeStore.getState();
  const entry = ownedFilesEntry(started);
  if (!entry) return;
  usePullRequestCodeStore.setState({
    entries: {
      ...state.entries,
      [started.snapshotKey]: {
        ...entry,
        filesLane: {
          ...entry.filesLane,
          status: "error",
          operationId: null,
          error,
        },
      },
    },
  });
}

function activeCodeSnapshot(): { snapshotKey: string; entry: PullRequestCodeEntry } | null {
  const state = usePullRequestCodeStore.getState();
  const snapshotKey = state.activeSnapshotKey;
  const entry = snapshotKey ? state.entries[snapshotKey] : undefined;
  return snapshotKey && entry ? { snapshotKey, entry } : null;
}

function patchLaneKey(entry: PullRequestCodeEntry, file: PullRequestFile): string {
  return getPullRequestPatchKey(
    entry.viewerNodeId,
    entry.identity,
    entry.baseOid,
    entry.headOid,
    file.locator,
  );
}

type RetainedPatchFields = Pick<
  PullRequestPatchLaneState,
  "result" | "rawBytes" | "parsedBytes" | "tokenBytes" | "estimatedBytes"
>;

const EMPTY_RETAINED_PATCH_FIELDS: RetainedPatchFields = {
  result: null,
  rawBytes: 0,
  parsedBytes: 0,
  tokenBytes: 0,
  estimatedBytes: 0,
};

function retainedPatchFields(
  current: PullRequestPatchLaneState | undefined,
): RetainedPatchFields {
  if (!current) return EMPTY_RETAINED_PATCH_FIELDS;
  return {
    result: current.result,
    rawBytes: current.rawBytes,
    parsedBytes: current.parsedBytes,
    tokenBytes: current.tokenBytes,
    estimatedBytes: current.estimatedBytes,
  };
}

function patchLaneState(
  patchKey: string,
  snapshotKey: string,
  file: PullRequestFile,
  current: PullRequestPatchLaneState | undefined,
  operationId: string,
  generation: number,
): PullRequestPatchLaneState {
  const retained = retainedPatchFields(current);
  return {
    patchKey,
    snapshotKey,
    locator: file.locator,
    path: file.path,
    blobOid: file.blobOid,
    status: "loading",
    operationId,
    generation,
    error: null,
    ...retained,
    lastAccessedAt: nextAccess(),
  };
}

function beginPatchLane(file: PullRequestFile): StartedPatchLane | null {
  const state = usePullRequestCodeStore.getState();
  const active = activeCodeSnapshot();
  if (!active) return null;
  const { snapshotKey, entry } = active;
  const patchKey = patchLaneKey(entry, file);
  const current = state.patches[patchKey];
  if (current?.status === "ready" || current?.operationId) return null;
  const operationId = nextOperationId("patch");
  const generation = (current?.generation ?? 0) + 1;
  const lane = patchLaneState(patchKey, snapshotKey, file, current, operationId, generation);
  usePullRequestCodeStore.setState({
    patches: { ...state.patches, [patchKey]: lane },
    patchPresentationRevision: state.patchPresentationRevision + 1,
  });
  return {
    patchKey,
    snapshotKey,
    operationId,
    generation,
    file,
  };
}

function ownedPatchLane(started: StartedPatchLane): PullRequestPatchLaneState | null {
  const lane = usePullRequestCodeStore.getState().patches[started.patchKey];
  if (
    !lane ||
    lane.operationId !== started.operationId ||
    lane.generation !== started.generation
  ) {
    return null;
  }
  return lane;
}

function failPatchLane(started: StartedPatchLane, error: PullRequestError): void {
  const state = usePullRequestCodeStore.getState();
  const lane = ownedPatchLane(started);
  if (!lane) return;
  usePullRequestCodeStore.setState({
    patches: {
      ...state.patches,
      [started.patchKey]: {
        ...lane,
        status: "error",
        operationId: null,
        error,
      },
    },
    patchPresentationRevision: state.patchPresentationRevision + 1,
  });
}

function patchLineCount(patch: string): number {
  if (patch.length === 0) return 0;
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
}

function patchWithinWebBounds(result: PullRequestPatchSuccess): boolean {
  if (result.status !== "available" && result.status !== "generated") return true;
  if (textEncoder.encode(result.patch).byteLength > PULL_REQUEST_PATCH_MAX_BYTES) {
    return false;
  }
  if (
    result.parsedLineCount > PULL_REQUEST_PATCH_MAX_LINES ||
    result.parsedLineCount !== patchLineCount(result.patch)
  ) {
    return false;
  }
  return result.patch
    .split("\n")
    .every(
      (line) =>
        textEncoder.encode(line).byteLength <= PULL_REQUEST_PATCH_MAX_LINE_LENGTH,
    );
}

function tooLargePatchResult(
  result: PullRequestPatchSuccess,
): PullRequestPatchSuccess {
  return {
    ...result,
    status: "too_large",
    patch: null,
    parsedLineCount: null,
  };
}

function patchMatchesFile(
  result: PullRequestPatchSuccess,
  entry: PullRequestCodeEntry,
  file: PullRequestFile,
): boolean {
  return (
    result.baseOid === entry.baseOid &&
    result.headOid === entry.headOid &&
    result.locator === file.locator &&
    result.path === file.path &&
    result.previousPath === file.previousPath &&
    result.changeType === file.changeType &&
    result.blobOid === file.blobOid
  );
}

interface SnapshotMutation {
  entries: Record<string, PullRequestCodeEntry>;
  patches: Record<string, PullRequestPatchLaneState>;
  operationIds: string[];
}

function clearPreviousActiveSnapshot(
  entries: Record<string, PullRequestCodeEntry>,
  patches: Record<string, PullRequestPatchLaneState>,
  activeSnapshotKey: string | null,
  snapshotKey: string,
): SnapshotMutation {
  const active = activeSnapshotKey ? entries[activeSnapshotKey] : undefined;
  if (!active || active.snapshotKey === snapshotKey) return { entries, patches, operationIds: [] };
  const operationIds = activeOperationIds(active, patches);
  const cleared = clearSnapshotOperations(active, patches);
  return {
    entries: { ...entries, [active.snapshotKey]: cleared.entry },
    patches: cleared.patches,
    operationIds,
  };
}

function removeSupersededSnapshots(
  mutation: SnapshotMutation,
  viewerNodeId: string,
  identity: PullRequestIdentity,
  snapshotKey: string,
): SnapshotMutation {
  const entries = { ...mutation.entries };
  const patches = { ...mutation.patches };
  const operationIds = [...mutation.operationIds];
  const nextIdentityKey = identityKey(identity);
  for (const [key, entry] of Object.entries(entries)) {
    const sameViewerIdentity = entry.viewerNodeId === viewerNodeId && entry.identityKey === nextIdentityKey;
    if (!sameViewerIdentity || key === snapshotKey) continue;
    operationIds.push(...activeOperationIds(entry, patches));
    delete entries[key];
    for (const [patchKey, patch] of Object.entries(patches)) {
      if (patch.snapshotKey === key) delete patches[patchKey];
    }
  }
  return { entries, patches, operationIds };
}

type PullRequestFilesResponse = Extract<
  Awaited<ReturnType<PullRequestTransport["files"]>>,
  { ok: true }
>;

function requestFiles(
  started: StartedFilesLane,
  entry: PullRequestCodeEntry,
  transport: PullRequestTransport,
) {
  return transport.files({
    operationId: started.operationId,
    identity: entry.identity,
    baseOid: entry.baseOid,
    headOid: entry.headOid,
    search: started.query.search || undefined,
    changeTypes: started.query.changeTypes,
    limit: FILE_PAGE_SIZE,
    ...(started.append && started.cursor ? { cursor: started.cursor } : {}),
  });
}

function filesMatchEntry(
  result: PullRequestFilesResponse,
  entry: PullRequestCodeEntry,
): boolean {
  return result.baseOid === entry.baseOid && result.headOid === entry.headOid;
}

function mergedFilePage(
  entry: PullRequestCodeEntry,
  result: PullRequestFilesResponse,
  append: boolean,
): {
  files: PullRequestFile[];
  boundedData: PullRequestBoundedDataMarker | null;
  nextCursor: string | null;
} {
  const filesByLocator = new Map((append ? entry.files : []).map((file) => [file.locator, file]));
  for (const file of result.items) filesByLocator.set(file.locator, file);
  const locallyBounded = filesByLocator.size > PULL_REQUEST_FILE_MAX_COUNT;
  const boundedData = locallyBounded ? { reason: "provider_limit" as const } : result.boundedData;
  const canContinueCatchUp = boundedData?.reason === "catch_up_limit";
  return {
    files: [...filesByLocator.values()].slice(0, PULL_REQUEST_FILE_MAX_COUNT),
    boundedData,
    nextCursor: boundedData && !canContinueCatchUp ? null : result.nextCursor,
  };
}

function nextExpandedPaths(
  started: StartedFilesLane,
  entry: PullRequestCodeEntry,
  files: readonly PullRequestFile[],
): Record<string, true> {
  const shouldSeed = !started.append && entry.files.length === 0 && Object.keys(entry.expandedPaths).length === 0 && files.length > 0;
  return shouldSeed
    ? Object.fromEntries(files.slice(0, 1).map((file) => [file.path, true] as const))
    : entry.expandedPaths;
}

function commitFilesPage(started: StartedFilesLane, result: PullRequestFilesResponse): void {
  const latestState = usePullRequestCodeStore.getState();
  const entry = ownedFilesEntry(started);
  if (!entry) return;
  const page = mergedFilePage(entry, result, started.append);
  usePullRequestCodeStore.setState({
    entries: {
      ...latestState.entries,
      [started.snapshotKey]: {
        ...entry,
        files: page.files,
        activePath: entry.activePath ?? page.files[0]?.path ?? null,
        expandedPaths: nextExpandedPaths(started, entry, page.files),
        filesLane: {
          ...entry.filesLane,
          status: "ready",
          operationId: null,
          error: null,
          nextCursor: page.nextCursor,
          fetchedAt: Date.parse(result.fetchedAt),
          staleAt: Date.parse(result.staleAt),
          boundedData: page.boundedData,
          complete: page.nextCursor === null && page.boundedData === null,
          partialReason: page.boundedData ? "bounded" : null,
        },
        lastAccessedAt: nextAccess(),
      },
    },
  });
}

async function loadFilesLane(
  started: StartedFilesLane,
  transport: PullRequestTransport,
): Promise<void> {
  try {
    const before = usePullRequestCodeStore.getState().entries[started.snapshotKey];
    if (!before) return;
    const result = await requestFiles(started, before, transport);
    const current = ownedFilesEntry(started);
    if (!current) return;
    if (!result.ok) return failFilesLane(started, result.error);
    if (!filesMatchEntry(result, current)) {
      return failFilesLane(started, {
        code: "conflict",
        message: "The pull request changed while Code files were loading.",
      });
    }
    commitFilesPage(started, result);
  } catch (error) {
    failFilesLane(started, normalizeError(error));
  }
}

async function prepareLoadAllFiles(
  transport: PullRequestTransport | undefined,
): Promise<string | null> {
  const state = usePullRequestCodeStore.getState();
  const snapshotKey = state.activeSnapshotKey;
  const entry = snapshotKey ? state.entries[snapshotKey] : undefined;
  if (!snapshotKey || !entry) return null;
  if (entry.filesLane.fetchedAt === null) await state.loadFiles({ transport });
  return snapshotKey;
}

function catchUpCursor(snapshotKey: string): string | null {
  const state = usePullRequestCodeStore.getState();
  if (state.activeSnapshotKey !== snapshotKey) return null;
  const entry = state.entries[snapshotKey];
  if (!entry || !entry.filesLane.nextCursor) return null;
  const boundedData = entry.filesLane.boundedData;
  return boundedData && boundedData.reason !== "catch_up_limit"
    ? null
    : entry.filesLane.nextCursor;
}

function markCursorStalled(snapshotKey: string): void {
  const state = usePullRequestCodeStore.getState();
  const entry = state.entries[snapshotKey];
  if (!entry) return;
  usePullRequestCodeStore.setState({
    entries: {
      ...state.entries,
      [snapshotKey]: {
        ...entry,
        filesLane: { ...entry.filesLane, complete: false, partialReason: "cursor_stalled" },
      },
    },
  });
}

function existingPatchPromise(file: PullRequestFile): Promise<void> | null {
  const active = activeCodeSnapshot();
  if (!active) return Promise.resolve();
  const patchKey = patchLaneKey(active.entry, file);
  const existing = usePullRequestCodeStore.getState().patches[patchKey];
  if (existing?.status === "ready") {
    usePullRequestCodeStore.getState().touchPatch(patchKey);
    return Promise.resolve();
  }
  return existing?.operationId ? (patchPromises.get(patchKey) ?? Promise.resolve()) : null;
}

function requestPatch(
  started: StartedPatchLane,
  entry: PullRequestCodeEntry,
  transport: PullRequestTransport,
) {
  return transport.patch({
    operationId: started.operationId,
    identity: entry.identity,
    baseOid: entry.baseOid,
    headOid: entry.headOid,
    locator: started.file.locator,
  });
}

function patchResultBytes(result: PullRequestPatchSuccess): number {
  return result.status === "available" || result.status === "generated"
    ? textEncoder.encode(result.patch).byteLength
    : 0;
}

function completePatchLane(started: StartedPatchLane, result: PullRequestPatchSuccess): void {
  const boundedResult = patchWithinWebBounds(result) ? result : tooLargePatchResult(result);
  const rawBytes = patchResultBytes(boundedResult);
  const latest = usePullRequestCodeStore.getState();
  const lane = ownedPatchLane(started);
  if (!lane) return;
  const completed: PullRequestPatchLaneState = {
    ...lane,
    status: "ready",
    operationId: null,
    error: null,
    result: boundedResult,
    rawBytes,
    parsedBytes: 0,
    tokenBytes: 0,
    estimatedBytes: rawBytes,
    lastAccessedAt: nextAccess(),
  };
  const patches = evictPatchLru({ ...latest.patches, [started.patchKey]: completed }, started.patchKey);
  usePullRequestCodeStore.setState({
    patches,
    patchPresentationRevision: usePullRequestCodeStore.getState().patchPresentationRevision + 1,
  });
}

async function loadPatchLane(
  started: StartedPatchLane,
  transport: PullRequestTransport,
): Promise<void> {
  try {
    const before = usePullRequestCodeStore.getState().entries[started.snapshotKey];
    if (!before) return;
    const result = await requestPatch(started, before, transport);
    const lane = ownedPatchLane(started);
    const entry = usePullRequestCodeStore.getState().entries[started.snapshotKey];
    if (!lane || !entry) return;
    if (!result.ok) return failPatchLane(started, result.error);
    if (!patchMatchesFile(result, entry, started.file)) {
      return failPatchLane(started, {
        code: "conflict",
        message: "The file changed while its patch was loading.",
      });
    }
    completePatchLane(started, result);
  } catch (error) {
    failPatchLane(started, normalizeError(error));
  }
}

/** Bounded immutable-head store for pull request files and patches. */
export const usePullRequestCodeStore = create<PullRequestCodeStoreState>(
  (set, get) => ({
    entries: {},
    patches: {},
    activeSnapshotKey: null,
    patchPresentationRevision: 0,

    activateSnapshot: (input, transportOverride) => {
      const snapshotKey = getPullRequestCodeSnapshotKey(
        input.viewerNodeId,
        input.identity,
        input.baseOid,
        input.headOid,
      );
      const state = get();
      const nextIdentityKey = identityKey(input.identity);
      const cleared = clearPreviousActiveSnapshot(
        state.entries,
        state.patches,
        state.activeSnapshotKey,
        snapshotKey,
      );
      const retained = removeSupersededSnapshots(
        cleared,
        input.viewerNodeId,
        input.identity,
        snapshotKey,
      );
      const entry = retained.entries[snapshotKey] ?? createEntry(input);
      retained.entries[snapshotKey] = { ...entry, lastAccessedAt: nextAccess() };
      const evicted = evictSnapshots(retained.entries, retained.patches, snapshotKey);
      const operationIds = [...retained.operationIds, ...evicted.operationIds];
      set({
        entries: evicted.entries,
        patches: evicted.patches,
        activeSnapshotKey: snapshotKey,
        patchPresentationRevision: state.patchPresentationRevision + 1,
      });
      usePullRequestReviewDraftStore.getState().reconcileActiveSnapshot({
        identityKey: nextIdentityKey,
        baseOid: input.baseOid,
        headOid: input.headOid,
      });
      if (operationIds.length > 0) {
        void cancelOperationIds(
          operationIds,
          transportOverride ?? getPullRequestTransport(),
        );
      }
      return snapshotKey;
    },

    setFileQuery: (query, transportOverride) => {
      const state = get();
      const snapshotKey = state.activeSnapshotKey;
      const entry = snapshotKey ? state.entries[snapshotKey] : undefined;
      if (!snapshotKey || !entry) return;
      const normalized = normalizeQuery(query);
      if (queriesMatch(entry.query, normalized)) return;
      const operationId = entry.filesLane.operationId;
      set({
        entries: {
          ...state.entries,
          [snapshotKey]: {
            ...entry,
            query: normalized,
            files: [],
            activePath: null,
            expandedPaths: {},
            filesLane: emptyFilesLane(entry.filesLane.generation + 1),
            lastAccessedAt: nextAccess(),
          },
        },
      });
      if (operationId) {
        void cancelOperationIds(
          [operationId],
          transportOverride ?? getPullRequestTransport(),
        );
      }
    },

    loadFiles: (options = {}) => {
      const state = get();
      const snapshotKey = state.activeSnapshotKey;
      if (!snapshotKey) return Promise.resolve();
      const existing = state.entries[snapshotKey];
      if (existing?.filesLane.operationId) {
        return filePromises.get(snapshotKey) ?? Promise.resolve();
      }
      const started = beginFilesLane(options.append ?? false);
      if (!started) return Promise.resolve();
      const transport = options.transport ?? getPullRequestTransport();
      const promise = loadFilesLane(started, transport);
      filePromises.set(snapshotKey, promise);
      void promise.finally(() => {
        if (filePromises.get(snapshotKey) === promise) filePromises.delete(snapshotKey);
      });
      return promise;
    },

    loadAllFiles: async (transportOverride) => {
      const initialKey = await prepareLoadAllFiles(transportOverride);
      if (!initialKey) return;
      const seenCursors = new Set<string>();
      while (true) {
        const cursor = catchUpCursor(initialKey);
        if (!cursor) return;
        if (seenCursors.has(cursor)) {
          markCursorStalled(initialKey);
          return;
        }
        seenCursors.add(cursor);
        await get().loadFiles({ append: true, transport: transportOverride });
      }
    },

    ensurePatch: (file, transportOverride) => {
      const existing = existingPatchPromise(file);
      if (existing) return existing;
      const started = beginPatchLane(file);
      if (!started) return Promise.resolve();
      const transport = transportOverride ?? getPullRequestTransport();
      const promise = loadPatchLane(started, transport);
      patchPromises.set(started.patchKey, promise);
      void promise.finally(() => {
        if (patchPromises.get(started.patchKey) === promise) patchPromises.delete(started.patchKey);
      });
      return promise;
    },

    reportPatchDerivedBytes: (patchKey, bytes) => {
      const state = get();
      const lane = state.patches[patchKey];
      if (!lane || lane.status !== "ready") return false;
      const parsedBytes = Math.max(0, Math.floor(bytes.parsedBytes ?? lane.parsedBytes));
      const tokenBytes = Math.max(0, Math.floor(bytes.tokenBytes ?? lane.tokenBytes));
      const estimatedBytes = lane.rawBytes + parsedBytes + tokenBytes;
      if (estimatedBytes > PULL_REQUEST_CODE_CACHE_MAX_BYTES) return false;
      const candidate: PullRequestPatchLaneState = {
        ...lane,
        parsedBytes,
        tokenBytes,
        estimatedBytes,
        lastAccessedAt: nextAccess(),
      };
      const patches = evictPatchLru(
        { ...state.patches, [patchKey]: candidate },
        patchKey,
      );
      if (patchCacheBytes(patches) > PULL_REQUEST_CODE_CACHE_MAX_BYTES) return false;
      set({
        patches,
        patchPresentationRevision:
          Object.keys(patches).length === Object.keys(state.patches).length
            ? state.patchPresentationRevision
            : state.patchPresentationRevision + 1,
      });
      return true;
    },

    clearPatchDerivedBytes: (patchKey) => {
      const state = get();
      const lane = state.patches[patchKey];
      if (!lane) return;
      set({
        patches: {
          ...state.patches,
          [patchKey]: {
            ...lane,
            parsedBytes: 0,
            tokenBytes: 0,
            estimatedBytes: lane.rawBytes,
            lastAccessedAt: nextAccess(),
          },
        },
      });
    },

    touchPatch: (patchKey) => {
      const state = get();
      const lane = state.patches[patchKey];
      if (!lane) return;
      set({
        patches: {
          ...state.patches,
          [patchKey]: { ...lane, lastAccessedAt: nextAccess() },
        },
      });
    },

    toggleFileExpanded: (path) => {
      const state = get();
      const key = state.activeSnapshotKey;
      const entry = key ? state.entries[key] : undefined;
      if (!key || !entry) return;
      const expandedPaths = { ...entry.expandedPaths };
      if (expandedPaths[path]) delete expandedPaths[path];
      else expandedPaths[path] = true;
      set({
        entries: {
          ...state.entries,
          [key]: {
            ...entry,
            expandedPaths,
            activePath: path,
            lastAccessedAt: nextAccess(),
          },
        },
      });
    },

    expandAll: (paths) => {
      const state = get();
      const key = state.activeSnapshotKey;
      const entry = key ? state.entries[key] : undefined;
      if (!key || !entry) return;
      set({
        entries: {
          ...state.entries,
          [key]: {
            ...entry,
            expandedPaths: Object.fromEntries(
              paths.map((path) => [path, true] as const),
            ),
            lastAccessedAt: nextAccess(),
          },
        },
      });
    },

    collapseAll: () => {
      const state = get();
      const key = state.activeSnapshotKey;
      const entry = key ? state.entries[key] : undefined;
      if (!key || !entry) return;
      set({
        entries: {
          ...state.entries,
          [key]: { ...entry, expandedPaths: {}, lastAccessedAt: nextAccess() },
        },
      });
    },

    setActivePath: (path) => {
      const state = get();
      const key = state.activeSnapshotKey;
      const entry = key ? state.entries[key] : undefined;
      if (!key || !entry || entry.activePath === path) return;
      set({
        entries: {
          ...state.entries,
          [key]: { ...entry, activePath: path, lastAccessedAt: nextAccess() },
        },
      });
    },

    setViewMode: (mode) => {
      const state = get();
      const key = state.activeSnapshotKey;
      const entry = key ? state.entries[key] : undefined;
      if (!key || !entry || entry.viewMode === mode) return;
      set({
        entries: {
          ...state.entries,
          [key]: { ...entry, viewMode: mode, lastAccessedAt: nextAccess() },
        },
      });
    },

    setFileTreeVisible: (visible) => {
      const state = get();
      const key = state.activeSnapshotKey;
      const entry = key ? state.entries[key] : undefined;
      if (!key || !entry || entry.fileTreeVisible === visible) return;
      set({
        entries: {
          ...state.entries,
          [key]: {
            ...entry,
            fileTreeVisible: visible,
            lastAccessedAt: nextAccess(),
          },
        },
      });
    },

    invalidateAfterMutation: async (identity, transportOverride) => {
      const state = get();
      const targetIdentityKey = identityKey(identity);
      const entries = { ...state.entries };
      const patches = { ...state.patches };
      const operationIds: string[] = [];
      let changed = false;
      for (const [snapshotKey, entry] of Object.entries(entries)) {
        if (entry.identityKey !== targetIdentityKey) continue;
        operationIds.push(...activeOperationIds(entry, patches));
        for (const [patchKey, patch] of Object.entries(patches)) {
          if (patch.snapshotKey === snapshotKey) delete patches[patchKey];
        }
        entries[snapshotKey] = {
          ...entry,
          files: [],
          filesLane: emptyFilesLane(entry.filesLane.generation + 1),
          activePath: null,
          lastAccessedAt: nextAccess(),
        };
        filePromises.delete(snapshotKey);
        changed = true;
      }
      if (!changed) return;
      set({
        entries,
        patches,
        patchPresentationRevision: state.patchPresentationRevision + 1,
      });
      await cancelOperationIds(
        operationIds,
        transportOverride ?? getPullRequestTransport(),
      );
    },

    cancelActive: async (transportOverride) => {
      const state = get();
      const key = state.activeSnapshotKey;
      const entry = key ? state.entries[key] : undefined;
      if (!key || !entry) return;
      const operationIds = activeOperationIds(entry, state.patches);
      const cleared = clearSnapshotOperations(entry, state.patches);
      set({
        entries: { ...state.entries, [key]: cleared.entry },
        patches: cleared.patches,
        patchPresentationRevision: state.patchPresentationRevision + 1,
      });
      await cancelOperationIds(
        operationIds,
        transportOverride ?? getPullRequestTransport(),
      );
    },

    reset: (transportOverride) => {
      const state = get();
      const operationIds = Object.values(state.entries).flatMap((entry) =>
        activeOperationIds(entry, state.patches),
      );
      filePromises.clear();
      patchPromises.clear();
      set({
        entries: {},
        patches: {},
        activeSnapshotKey: null,
        patchPresentationRevision: state.patchPresentationRevision + 1,
      });
      if (operationIds.length > 0) {
        void cancelOperationIds(
          operationIds,
          transportOverride ?? getPullRequestTransport(),
        );
      }
    },
  }),
);
