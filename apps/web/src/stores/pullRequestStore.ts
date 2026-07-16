import type {
  PullRequestActor,
  PullRequestCapabilities,
  PullRequestCapabilityReason,
  PullRequestCapabilityLimitation,
  PullRequestError,
  PullRequestRelationship,
  PullRequestState,
  PullRequestSummary,
} from "@mcode/contracts";
import { create } from "zustand";
import {
  getPullRequestTransport,
  type PullRequestTransport,
} from "@/transport/pull-requests";

/** Relationship tab exposed by the pull request inbox. */
export type PullRequestInboxRelationship = "all" | "reviewing" | "authored";

/** Request status for the current pull request inbox query. */
export type PullRequestInboxStatus =
  "idle" | "loading" | "ready" | "refreshing" | "error";

/** Aggregate check states available to the pull request inbox filter. */
export type PullRequestCheckState = PullRequestSummary["checks"]["state"];

interface PullRequestPageCacheEntry {
  items: PullRequestSummary[];
  nextCursor: string | null;
  snapshotVersion: string;
  fetchedAt: string;
  staleAt: string;
}

/** Public state and actions for the normalized pull request inbox. */
export interface PullRequestStoreState {
  entities: Record<string, PullRequestSummary>;
  orderedKeys: string[];
  pages: PullRequestPageCacheEntry[];
  relationship: PullRequestInboxRelationship;
  loadedRelationship: PullRequestInboxRelationship | null;
  states: PullRequestState[];
  search: string;
  repositoryFilter: string | null;
  authorFilter: string | null;
  reviewFilters: PullRequestRelationship[];
  checkFilters: PullRequestCheckState[];
  selectedKey: string | null;
  nextCursor: string | null;
  snapshotVersion: string | null;
  fetchedAt: number | null;
  staleAt: number | null;
  stale: boolean;
  status: PullRequestInboxStatus;
  error: PullRequestError | null;
  capabilities: PullRequestCapabilities | null;
  viewer: PullRequestActor | null;
  limitations: PullRequestCapabilityLimitation[];
  activeCapabilitiesOperationId: string | null;
  activeListOperationId: string | null;
  setRelationship: (relationship: PullRequestInboxRelationship) => void;
  setStates: (states: PullRequestState[]) => void;
  setSearch: (search: string) => void;
  setRepositoryFilter: (repository: string | null) => void;
  setAuthorFilter: (author: string | null) => void;
  toggleReviewFilter: (relationship: PullRequestRelationship) => void;
  toggleCheckFilter: (check: PullRequestCheckState) => void;
  clearLocalFilters: () => void;
  setSelectedKey: (key: string | null) => void;
  moveSelection: (delta: number) => void;
  selectBoundary: (boundary: "first" | "last") => void;
  loadCapabilities: (transport?: PullRequestTransport) => Promise<boolean>;
  loadFirstPage: (transport?: PullRequestTransport) => Promise<void>;
  loadNextPage: (transport?: PullRequestTransport) => Promise<void>;
  refreshIfStale: (transport?: PullRequestTransport) => Promise<void>;
  /** Mark inbox data stale and refresh the first page after a remote mutation. */
  invalidateAfterMutation: (transport?: PullRequestTransport) => Promise<void>;
  cancelActive: (transport?: PullRequestTransport) => Promise<void>;
  reset: () => void;
}

const MAX_CACHED_PAGES = 10;
const MAX_NORMALIZED_RESULTS = 1_000;
const DEFAULT_RELATIONSHIPS: PullRequestRelationship[] = [
  "authored",
  "direct_review_requested",
  "team_review_requested",
  "reviewed",
];
const REVIEWING_RELATIONSHIPS: PullRequestRelationship[] = [
  "direct_review_requested",
  "team_review_requested",
  "reviewed",
];
let operationSequence = 0;

const dataInitialState = {
  entities: {} as Record<string, PullRequestSummary>,
  orderedKeys: [] as string[],
  pages: [] as PullRequestPageCacheEntry[],
  relationship: "all" as PullRequestInboxRelationship,
  loadedRelationship: null as PullRequestInboxRelationship | null,
  states: ["open"] as PullRequestState[],
  search: "",
  repositoryFilter: null as string | null,
  authorFilter: null as string | null,
  reviewFilters: [] as PullRequestRelationship[],
  checkFilters: [] as PullRequestCheckState[],
  selectedKey: null as string | null,
  nextCursor: null as string | null,
  snapshotVersion: null as string | null,
  fetchedAt: null as number | null,
  staleAt: null as number | null,
  stale: false,
  status: "idle" as PullRequestInboxStatus,
  error: null as PullRequestError | null,
  capabilities: null as PullRequestCapabilities | null,
  viewer: null as PullRequestActor | null,
  limitations: [] as PullRequestCapabilityLimitation[],
  activeCapabilitiesOperationId: null as string | null,
  activeListOperationId: null as string | null,
};

/** Return the stable provider-neutral key for a pull request summary. */
export function getPullRequestKey(summary: PullRequestSummary): string {
  const { provider, repositoryNodeId, number } = summary.identity;
  return `${provider}:${repositoryNodeId}:${number}`;
}

/** Return the relationship query represented by an inbox tab. */
export function getRelationshipsForInboxTab(
  relationship: PullRequestInboxRelationship,
): PullRequestRelationship[] {
  if (relationship === "authored") return ["authored"];
  if (relationship === "reviewing") return REVIEWING_RELATIONSHIPS;
  return DEFAULT_RELATIONSHIPS;
}

/** Return whether an inbox snapshot is older than its server-provided stale time. */
export function isPullRequestSnapshotStale(
  staleAt: number | null,
  now = Date.now(),
): boolean {
  return staleAt === null || now >= staleAt;
}

function createOperationId(kind: "cap" | "list"): string {
  operationSequence += 1;
  return `pr-${kind}-${Date.now().toString(36)}-${operationSequence.toString(36)}`;
}

function deniedCapabilitiesForError(
  error: PullRequestError,
): PullRequestCapabilities {
  const reason: PullRequestCapabilityReason =
    error.code === "unauthenticated"
      ? "unauthenticated"
      : error.code === "forbidden"
        ? "forbidden"
        : "remote_unavailable";
  const denied = { allowed: false, reason } as const;
  return {
    read: denied,
    teamRequests: denied,
    comment: denied,
    review: denied,
    readiness: denied,
    close: denied,
    merge: denied,
    reviewWorktree: denied,
  };
}

function mergeSummary(
  current: PullRequestSummary | undefined,
  incoming: PullRequestSummary,
): PullRequestSummary {
  if (!current) return incoming;
  const relationships = Array.from(
    new Set([...current.relationships, ...incoming.relationships]),
  ) as PullRequestRelationship[];
  return {
    ...(Date.parse(incoming.updatedAt) >= Date.parse(current.updatedAt)
      ? incoming
      : current),
    relationships,
  };
}

function mergeNormalizedResults(
  currentEntities: Record<string, PullRequestSummary>,
  currentOrderedKeys: string[],
  items: PullRequestSummary[],
): {
  entities: Record<string, PullRequestSummary>;
  orderedKeys: string[];
} {
  const entities = { ...currentEntities };
  const orderedKeys = [...currentOrderedKeys];
  for (const item of items) {
    const key = getPullRequestKey(item);
    if (!entities[key]) orderedKeys.push(key);
    entities[key] = mergeSummary(entities[key], item);
  }

  if (orderedKeys.length <= MAX_NORMALIZED_RESULTS) {
    return { entities, orderedKeys };
  }

  const boundedKeys = orderedKeys.slice(0, MAX_NORMALIZED_RESULTS);
  const boundedEntities = Object.fromEntries(
    boundedKeys.flatMap((key) => {
      const item = entities[key];
      return item ? [[key, item] as const] : [];
    }),
  );
  return { entities: boundedEntities, orderedKeys: boundedKeys };
}

async function cancelOperation(
  operationId: string | null,
  transport: PullRequestTransport,
): Promise<void> {
  if (!operationId) return;
  try {
    await transport.cancel({ operationId });
  } catch {
    // Selection and query changes must remain responsive when cancellation races disconnect.
  }
}

async function loadPage(
  append: boolean,
  transportOverride?: PullRequestTransport,
): Promise<void> {
  const transport = transportOverride ?? getPullRequestTransport();
  const before = usePullRequestStore.getState();
  const cursor = append ? before.nextCursor : null;
  if (append && !cursor) return;
  const requestRelationship = append
    ? (before.loadedRelationship ?? before.relationship)
    : before.relationship;

  const operationId = createOperationId("list");
  usePullRequestStore.setState({
    activeListOperationId: operationId,
    status: before.orderedKeys.length > 0 ? "refreshing" : "loading",
    error: null,
  });
  await cancelOperation(before.activeListOperationId, transport);
  if (usePullRequestStore.getState().activeListOperationId !== operationId)
    return;

  try {
    const result = await transport.list({
      operationId,
      provider: "github",
      relationships: getRelationshipsForInboxTab(requestRelationship),
      states: before.states,
      ...(cursor ? { cursor } : {}),
      limit: 30,
    });
    if (usePullRequestStore.getState().activeListOperationId !== operationId)
      return;

    if (!result.ok) {
      usePullRequestStore.setState((state) => ({
        activeListOperationId: null,
        status: "error",
        error: result.error,
        stale: state.orderedKeys.length > 0,
      }));
      return;
    }

    const page: PullRequestPageCacheEntry = {
      items: result.items,
      nextCursor: result.nextCursor,
      snapshotVersion: result.snapshotVersion,
      fetchedAt: result.fetchedAt,
      staleAt: result.staleAt,
    };
    const pages = (append ? [...before.pages, page] : [page]).slice(
      -MAX_CACHED_PAGES,
    );
    const normalized = mergeNormalizedResults(
      append ? before.entities : {},
      append ? before.orderedKeys : [],
      page.items,
    );
    const selectedKey =
      before.selectedKey && normalized.entities[before.selectedKey]
        ? before.selectedKey
        : (normalized.orderedKeys[0] ?? null);
    usePullRequestStore.setState({
      ...normalized,
      pages,
      loadedRelationship: requestRelationship,
      selectedKey,
      nextCursor:
        normalized.orderedKeys.length >= MAX_NORMALIZED_RESULTS
          ? null
          : result.nextCursor,
      snapshotVersion: result.snapshotVersion,
      fetchedAt: Date.parse(result.fetchedAt),
      staleAt: Date.parse(result.staleAt),
      stale: false,
      status: "ready",
      error: null,
      limitations: result.limitations,
      activeListOperationId: null,
    });
  } catch (error) {
    if (usePullRequestStore.getState().activeListOperationId !== operationId)
      return;
    usePullRequestStore.setState((state) => ({
      activeListOperationId: null,
      status: "error",
      stale: state.orderedKeys.length > 0,
      error: {
        code: "remote_unavailable",
        message:
          error instanceof Error
            ? error.message.slice(0, 512)
            : "Pull request read failed",
      },
    }));
  }
}

/** Normalized, bounded pull request inbox store. */
export const usePullRequestStore = create<PullRequestStoreState>(
  (set, get) => ({
    ...dataInitialState,
    setRelationship: (relationship) => set({ relationship }),
    setStates: (states) =>
      set({ states: states.length > 0 ? states : ["open"] }),
    setSearch: (search) => set({ search: search.trim().slice(0, 200) }),
    setRepositoryFilter: (repositoryFilter) => set({ repositoryFilter }),
    setAuthorFilter: (authorFilter) => set({ authorFilter }),
    toggleReviewFilter: (relationship) =>
      set((state) => ({
        reviewFilters: state.reviewFilters.includes(relationship)
          ? state.reviewFilters.filter((item) => item !== relationship)
          : [...state.reviewFilters, relationship],
      })),
    toggleCheckFilter: (check) =>
      set((state) => ({
        checkFilters: state.checkFilters.includes(check)
          ? state.checkFilters.filter((item) => item !== check)
          : [...state.checkFilters, check],
      })),
    clearLocalFilters: () =>
      set({
        repositoryFilter: null,
        authorFilter: null,
        reviewFilters: [],
        checkFilters: [],
      }),
    setSelectedKey: (selectedKey) => set({ selectedKey }),
    moveSelection: (delta) => {
      const { orderedKeys, selectedKey } = get();
      if (orderedKeys.length === 0) return;
      const currentIndex = selectedKey ? orderedKeys.indexOf(selectedKey) : -1;
      const nextIndex = Math.max(
        0,
        Math.min(orderedKeys.length - 1, currentIndex + delta),
      );
      set({ selectedKey: orderedKeys[nextIndex] ?? null });
    },
    selectBoundary: (boundary) => {
      const { orderedKeys } = get();
      set({
        selectedKey:
          boundary === "first"
            ? (orderedKeys[0] ?? null)
            : (orderedKeys[orderedKeys.length - 1] ?? null),
      });
    },
    loadCapabilities: async (transportOverride) => {
      const transport = transportOverride ?? getPullRequestTransport();
      const previousOperationId = get().activeCapabilitiesOperationId;
      const operationId = createOperationId("cap");
      set({ activeCapabilitiesOperationId: operationId });
      await cancelOperation(previousOperationId, transport);
      if (get().activeCapabilitiesOperationId !== operationId) return false;
      try {
        const result = await transport.getCapabilities({
          operationId,
          provider: "github",
        });
        if (get().activeCapabilitiesOperationId !== operationId) return false;
        if (result.ok) {
          set({
            capabilities: result.capabilities,
            viewer: result.viewer,
            activeCapabilitiesOperationId: null,
          });
          return true;
        } else {
          set({
            activeCapabilitiesOperationId: null,
            capabilities: deniedCapabilitiesForError(result.error),
            error: result.error,
            status: "error",
          });
          return false;
        }
      } catch (error) {
        if (get().activeCapabilitiesOperationId !== operationId) return false;
        const pullRequestError: PullRequestError = {
          code: "remote_unavailable",
          message:
            error instanceof Error
              ? error.message.slice(0, 512)
              : "Capability read failed",
        };
        set({
          activeCapabilitiesOperationId: null,
          capabilities: deniedCapabilitiesForError(pullRequestError),
          status: "error",
          error: pullRequestError,
        });
        return false;
      }
    },
    loadFirstPage: (transport) => loadPage(false, transport),
    loadNextPage: (transport) => loadPage(true, transport),
    refreshIfStale: async (transport) => {
      if (isPullRequestSnapshotStale(get().staleAt))
        await loadPage(false, transport);
    },
    invalidateAfterMutation: async (transport) => {
      set({ stale: true, staleAt: 0 });
      await loadPage(false, transport);
    },
    cancelActive: async (transportOverride) => {
      const {
        activeCapabilitiesOperationId,
        activeListOperationId,
      } = get();
      set({
        activeCapabilitiesOperationId: null,
        activeListOperationId: null,
      });
      const transport =
        transportOverride ?? getPullRequestTransport();
      await Promise.all(
        [activeCapabilitiesOperationId, activeListOperationId].map(
          (operationId) => cancelOperation(operationId, transport),
        ),
      );
    },
    reset: () => set(dataInitialState),
  }),
);
