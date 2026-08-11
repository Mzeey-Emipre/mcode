import type {
  ConversationNewerPageIdentity,
  ConversationOlderPage,
  ConversationOlderPageIdentity,
} from "@mcode/contracts";
import {
  createAdjacentPrefetchScheduler,
  type AdjacentPrefetchThread,
} from "@/lib/thread-hydrator/adjacent-prefetch";

/** A sidebar row that can be activated as a persisted conversation. */
export type ConversationResidencyThread = AdjacentPrefetchThread;

/** Dependency contract for conversation residency behavior. */
export interface ConversationResidencyDeps {
  restoreConversation: (threadId: string) => Promise<void>;
  refreshConversation: (threadId: string) => Promise<void>;
  deactivateConversation: () => void;
  retainInactiveConversation: (threadId: string) => void;
  invalidateConversation: (threadId: string) => void;
  synchronizeConversation: (threadId: string) => void;
  mergeCachedFileChanges: (threadId: string, filesChanged: Record<string, string[]>) => void;
  takePrefetchedHistoryPage: (
    identity: ConversationOlderPageIdentity,
  ) => ConversationOlderPage | undefined;
  prefetchConversation: (threadId: string) => Promise<void>;
}

type ConversationHistoryPageIdentity =
  | ConversationOlderPageIdentity
  | ConversationNewerPageIdentity;

/** One thread-owned history-page request that can commit only while it remains current. */
export interface ConversationHistoryPageRequestHandle {
  readonly id: number;
  readonly identity: ConversationHistoryPageIdentity;
}

function identitiesMatch(
  left: ConversationHistoryPageIdentity,
  right: ConversationHistoryPageIdentity,
): boolean {
  if (
    left.threadId !== right.threadId
    || left.direction !== right.direction
    || left.cursor.version !== right.cursor.version
    || left.generation !== right.generation
    || left.conversationRevision !== right.conversationRevision
  ) return false;
  return left.direction === "older" && right.direction === "older"
    ? left.cursor.beforeSequence === right.cursor.beforeSequence
    : left.direction === "newer" && right.direction === "newer"
      && left.cursor.afterSequence === right.cursor.afterSequence;
}

function currentStateCanMerge(
  request: ConversationHistoryPageIdentity,
  current: ConversationHistoryPageIdentity,
): boolean {
  return request.threadId === current.threadId
    && request.direction === current.direction
    && request.generation === current.generation
    && current.conversationRevision >= request.conversationRevision;
}

/**
 * Owns selected-conversation activation, revalidation, and cache routing.
 * Transport, cache freshness, and live-record precedence stay in ThreadHydrator.
 */
export class ConversationResidency {
  private activationGeneration = 0;
  private historyPageRequestId = 0;
  private readonly historyPageRequests = new Map<string, ConversationHistoryPageRequestHandle>();
  private readonly adjacentPrefetch;

  constructor(private readonly deps: ConversationResidencyDeps) {
    this.adjacentPrefetch = createAdjacentPrefetchScheduler({
      prefetch: deps.prefetchConversation,
    });
  }

  /** Activate the selected thread when it has a persisted conversation identity. */
  activate(threadId: string | null, threads: readonly ConversationResidencyThread[]): Promise<void> {
    const activationGeneration = ++this.activationGeneration;
    this.adjacentPrefetch.cancel();
    const thread = threadId ? threads.find((candidate) => candidate.id === threadId) : undefined;
    if (!thread || thread.clientPreparing || thread.clientError) {
      this.historyPageRequests.clear();
      this.deps.deactivateConversation();
      return Promise.resolve();
    }
    for (const requestThreadId of this.historyPageRequests.keys()) {
      if (requestThreadId !== thread.id) this.historyPageRequests.delete(requestThreadId);
    }
    return this.deps.restoreConversation(thread.id).then(() => {
      if (activationGeneration === this.activationGeneration) {
        this.adjacentPrefetch.activate(thread.id, threads);
      }
    });
  }

  /** Revalidate the selected transcript without clearing its resident rendering. */
  refresh(selectedThreadId: string | null, threads: readonly ConversationResidencyThread[]): Promise<void> {
    const thread = selectedThreadId ? threads.find((candidate) => candidate.id === selectedThreadId) : undefined;
    if (!thread || thread.clientPreparing || thread.clientError) return Promise.resolve();
    return this.deps.refreshConversation(thread.id);
  }

  /** Retain a completed background conversation through the bounded cache. */
  retainInactiveConversation(threadId: string): void {
    this.deps.retainInactiveConversation(threadId);
  }

  /** Invalidate stale conversation cache state before an authoritative mutation. */
  invalidateConversation(threadId: string): void {
    this.historyPageRequests.delete(threadId);
    this.deps.invalidateConversation(threadId);
  }

  /** Start or supersede the directional history-page request for one thread. */
  beginHistoryPageRequest(
    identity: ConversationHistoryPageIdentity,
  ): ConversationHistoryPageRequestHandle | undefined {
    const current = this.historyPageRequests.get(identity.threadId);
    if (current && identitiesMatch(current.identity, identity)) return undefined;
    const handle = { id: ++this.historyPageRequestId, identity };
    this.historyPageRequests.set(identity.threadId, handle);
    return handle;
  }

  /** Return true when the request, response, and current thread state still have one identity. */
  canCommitHistoryPageRequest(
    handle: ConversationHistoryPageRequestHandle,
    currentIdentity: ConversationHistoryPageIdentity,
    responseIdentity: ConversationHistoryPageIdentity = handle.identity,
  ): boolean {
    return this.historyPageRequests.get(handle.identity.threadId)?.id === handle.id
      && currentStateCanMerge(handle.identity, currentIdentity)
      && identitiesMatch(handle.identity, responseIdentity);
  }

  /** Release a request only when it still owns the thread's in-flight slot. */
  finishHistoryPageRequest(handle: ConversationHistoryPageRequestHandle): void {
    if (this.historyPageRequests.get(handle.identity.threadId)?.id === handle.id) {
      this.historyPageRequests.delete(handle.identity.threadId);
    }
  }

  /** Synchronize resident conversation content into the bounded cache. */
  synchronizeConversation(threadId: string): void {
    this.deps.synchronizeConversation(threadId);
  }

  /** Merge delayed pagination file metadata only into the current cache entry. */
  mergePaginationFileChanges(threadId: string, filesChanged: Record<string, string[]>): void {
    this.deps.mergeCachedFileChanges(threadId, filesChanged);
  }

  /** Consume the matching warm history page through the cache authority. */
  takePrefetchedHistoryPage(
    identity: ConversationOlderPageIdentity,
  ): ConversationOlderPage | undefined {
    return this.deps.takePrefetchedHistoryPage(identity);
  }

  /** Warm a non-selected conversation without mutating the live selection. */
  prefetch(threadId: string): Promise<void> {
    return this.deps.prefetchConversation(threadId);
  }
}

/** Create the internal authority for selected conversation residency. */
export function createConversationResidency(
  deps: ConversationResidencyDeps,
): ConversationResidency {
  return new ConversationResidency(deps);
}

let registeredConversationResidency: ConversationResidency | null = null;

/** Register the internal residency authority used by transport-facing paths. */
export function registerConversationResidency(residency: ConversationResidency): void {
  registeredConversationResidency = residency;
}

/** Return the internal residency authority after the thread store initializes it. */
export function getConversationResidency(): ConversationResidency {
  if (!registeredConversationResidency) {
    throw new Error("Conversation residency has not been initialized");
  }
  return registeredConversationResidency;
}
