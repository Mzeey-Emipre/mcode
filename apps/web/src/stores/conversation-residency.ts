import type { ConversationPage } from "@mcode/contracts";

/** A sidebar row that can be activated as a persisted conversation. */
export interface ConversationResidencyThread {
  id: string;
  clientPreparing?: boolean;
  clientError?: string | null;
}

/** Dependency contract for conversation residency behavior. */
export interface ConversationResidencyDeps {
  restoreConversation: (threadId: string) => Promise<void>;
  refreshConversation: (threadId: string) => Promise<void>;
  deactivateConversation: () => void;
  retainInactiveConversation: (threadId: string) => void;
  invalidateConversation: (threadId: string) => void;
  synchronizeConversation: (threadId: string) => void;
  mergeCachedFileChanges: (threadId: string, filesChanged: Record<string, string[]>) => void;
  takePrefetchedHistoryPage: (threadId: string, before: number) => ConversationPage | undefined;
  prefetchConversation: (threadId: string) => Promise<void>;
}

/**
 * Owns selected-conversation activation, revalidation, and cache routing.
 * Transport, cache freshness, and live-record precedence stay in ThreadHydrator.
 */
export class ConversationResidency {
  constructor(private readonly deps: ConversationResidencyDeps) {}

  /** Activate the selected thread when it has a persisted conversation identity. */
  activate(threadId: string | null, threads: readonly ConversationResidencyThread[]): Promise<void> {
    const thread = threadId ? threads.find((candidate) => candidate.id === threadId) : undefined;
    if (!thread || thread.clientPreparing || thread.clientError) {
      this.deps.deactivateConversation();
      return Promise.resolve();
    }
    return this.deps.restoreConversation(thread.id);
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
    this.deps.invalidateConversation(threadId);
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
  takePrefetchedHistoryPage(threadId: string, before: number): ConversationPage | undefined {
    return this.deps.takePrefetchedHistoryPage(threadId, before);
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
