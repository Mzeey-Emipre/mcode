/** A sidebar row that can be activated as a persisted conversation. */
export interface ConversationResidencyThread {
  id: string;
  clientPreparing?: boolean;
  clientError?: string | null;
}

/** Collaborators used to restore or deactivate the selected conversation layer. */
export interface ConversationResidencyDeps {
  restoreConversation: (threadId: string) => Promise<void>;
  deactivateConversation: () => void;
}

/**
 * Owns selected-conversation activation and post-refresh restoration.
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

  /** Reconcile an unchanged selection after its workspace rows refresh. */
  restoreAfterThreadRefresh(
    selectedThreadId: string | null,
    threads: readonly ConversationResidencyThread[],
  ): Promise<void> {
    return this.activate(selectedThreadId, threads);
  }
}

/** Create the internal authority for selected conversation residency. */
export function createConversationResidency(
  deps: ConversationResidencyDeps,
): ConversationResidency {
  return new ConversationResidency(deps);
}
