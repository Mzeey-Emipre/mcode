import type { Message, ToolCallRecord, ThoughtSegmentRecord, HookExecutionRecord } from "@/transport";
import type { TurnSnapshot, PermissionRequest, PlanRecord, NarrativeEntry, ConversationNewerPage, ConversationNewerPageRequest, ConversationOlderPage, ConversationOlderPageRequest, ConversationPage, ConversationTail, GoalLookupResult } from "@mcode/contracts";
import type { TaskItem } from "@/stores/taskStore";
import type { PlanQuestion } from "@mcode/contracts";
import type { ThreadRecord } from "@/stores/thread-record";

/** How a hydrate call commits its result. */
export type HydrateMode = "active" | "background";

/** Optional flags for a hydrate invocation. */
export interface ThreadHydratorOptions {
  /** When true, bypasses the auxiliary freshness TTL gate. */
  force?: boolean;
}

/** Lease-bound options for a non-selected displayed transcript. */
export interface DisplayHydrationOptions {
  /** Generation assigned by the display lease authority. */
  generation: number;
  /** Returns false after the final release or a newer lease takes ownership. */
  isCurrent: () => boolean;
  /** Bypass an existing resident or cache entry. */
  force?: boolean;
}

/** Paginated message list returned by the transport. */
export interface PaginatedMessages {
  messages: Message[];
  hasMore: boolean;
  answeredPlanMessageIds?: string[];
}

/** Narrative payload keyed by assistant message id. */
export type NarrativeBatchResult = Record<
  string,
  {
    tools: ToolCallRecord[];
    thoughts: ThoughtSegmentRecord[];
    hooks: HookExecutionRecord[];
  }
>;

/** Transport surface used by {@link ThreadHydrator}. */
export interface ThreadHydratorTransport {
  getMessages(threadId: string, limit: number, before?: number): Promise<PaginatedMessages>;
  loadConversationPage(threadId: string, limit: number, before?: number): Promise<ConversationPage>;
  loadOlderConversationPage(request: ConversationOlderPageRequest): Promise<ConversationOlderPage>;
  loadNewerConversationPage(request: ConversationNewerPageRequest): Promise<ConversationNewerPage>;
  /** Fetch only the bounded tail needed for first paint when supported. */
  loadConversationTail?: (threadId: string, limit: number) => Promise<ConversationTail>;
  listSnapshots(threadId: string): Promise<TurnSnapshot[]>;
  listNarrative(messageId: string): Promise<NarrativeBatchResult[string]>;
  loadTurn(threadId: string): Promise<NarrativeEntry[]>;
  getThreadGoal(threadId: string): Promise<GoalLookupResult>;
  listPendingPermissions(threadId: string): Promise<PermissionRequest[]>;
  getThreadTasks(
    threadId: string,
  ): Promise<Array<{ id?: string; content: string; status: string; activeForm?: string; group?: string }> | null>;
  getThreadPlans(threadId: string): Promise<PlanRecord[]>;
}

/** Workspace thread row fields consulted during hydration. */
export interface HydratorWorkspaceThread {
  id: string;
  has_file_changes?: boolean;
}

/** Store fields written during hydration (subset of threadStore). */
export interface ThreadHydratorWriteState {
  records: Map<string, ThreadRecord>;
  currentThreadId: string | null;
  runningThreadIds: Set<string>;
}

/** Read-only thread-store slice the hydrator needs. */
export interface ThreadHydratorState extends ThreadHydratorWriteState {
  toolCallRecordCache: { clear: () => void };
}

/** External collaborators injected into {@link ThreadHydrator}. */
export interface ThreadHydratorDeps {
  getTransport: () => ThreadHydratorTransport;
  getState: () => ThreadHydratorState;
  setState: (
    partial:
      | Partial<ThreadHydratorWriteState>
      | ((state: ThreadHydratorWriteState) => Partial<ThreadHydratorWriteState>),
  ) => void;
  getWorkspaceThread: (threadId: string) => HydratorWorkspaceThread | undefined;
  flushPendingTextDeltas: () => void;
  loadNarrativeForMessage: (messageId: string) => Promise<void>;
  setPlanQuestions: (threadId: string, questions: PlanQuestion[]) => void;
  extractPendingPlanQuestions: (
    messages: Message[],
    answeredIds: ReadonlySet<string>,
  ) => PlanQuestion[] | null;
  getTasksForThread: (threadId: string) => readonly TaskItem[];
  setTasksForThread: (threadId: string, tasks: readonly TaskItem[]) => void;
  addPlanForThread: (threadId: string, plan: PlanRecord) => void;
  shallowEqualBy: <T>(a: readonly T[], b: readonly T[], keys: (keyof T)[]) => boolean;
  coerceTaskStatus: (status: string) => TaskItem["status"];
  getWorkspaceThreadSettings: (threadId: string) => import("@/stores/thread-record").ThreadSettings;
  /** Protect leased transcripts from selected-thread retirement. */
  isDisplayConversationVisible?: (threadId: string) => boolean;
}
