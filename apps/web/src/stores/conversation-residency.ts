import type {
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

/** One thread-owned older-page request that can commit only while it remains current. */
export interface ConversationOlderPageRequestHandle {
  readonly id: number;
  readonly identity: ConversationOlderPageIdentity;
}

function identitiesMatch(
  left: ConversationOlderPageIdentity,
  right: ConversationOlderPageIdentity,
): boolean {
  return left.threadId === right.threadId
    && left.cursor.version === right.cursor.version
    && left.cursor.beforeSequence === right.cursor.beforeSequence
    && left.direction === right.direction
    && left.generation === right.generation
    && left.conversationRevision === right.conversationRevision;
}

/**
 * Owns selected-conversation activation, revalidation, and cache routing.
 * Transport, cache freshness, and live-record precedence stay in ThreadHydrator.
 */
export class ConversationResidency {
  private activationGeneration = 0;
  private olderPageRequestId = 0;
  private readonly olderPageRequests = new Map<string, ConversationOlderPageRequestHandle>();
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
      this.olderPageRequests.clear();
      this.deps.deactivateConversation();
      return Promise.resolve();
    }
    for (const requestThreadId of this.olderPageRequests.keys()) {
      if (requestThreadId !== thread.id) this.olderPageRequests.delete(requestThreadId);
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
    this.olderPageRequests.delete(threadId);
    this.deps.invalidateConversation(threadId);
  }

  /** Start or supersede the older-page request for one thread. */
  beginOlderPageRequest(
    identity: ConversationOlderPageIdentity,
  ): ConversationOlderPageRequestHandle | undefined {
    const current = this.olderPageRequests.get(identity.threadId);
    if (current && identitiesMatch(current.identity, identity)) return undefined;
    const handle = { id: ++this.olderPageRequestId, identity };
    this.olderPageRequests.set(identity.threadId, handle);
    return handle;
  }

  /** Return true when the request, response, and current thread state still have one identity. */
  canCommitOlderPageRequest(
    handle: ConversationOlderPageRequestHandle,
    currentIdentity: ConversationOlderPageIdentity,
    responseIdentity: ConversationOlderPageIdentity = handle.identity,
  ): boolean {
    return this.olderPageRequests.get(handle.identity.threadId)?.id === handle.id
      && identitiesMatch(handle.identity, currentIdentity)
      && identitiesMatch(handle.identity, responseIdentity);
  }

  /** Release a request only when it still owns the thread's in-flight slot. */
  finishOlderPageRequest(handle: ConversationOlderPageRequestHandle): void {
    if (this.olderPageRequests.get(handle.identity.threadId)?.id === handle.id) {
      this.olderPageRequests.delete(handle.identity.threadId);
    }
  }

  /** Commit a pagination page after its state guards have accepted it. */
  commitPagination(threadId: string): void {
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
