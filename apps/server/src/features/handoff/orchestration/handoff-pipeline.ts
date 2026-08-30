/**
 * Orchestrates chat fork handoff generation by delegating to each provider's
 * {@link SessionForker}.
 *
 * The pipeline builds a {@link ForkRequest} and calls `provider.forker.fork(req)`.
 * Each provider owns the strategy: clean-resume providers use CleanForker
 * (path B); unsupported providers use DeterministicForker (path D). The
 * `sessionForkOnResume` field
 * is now metadata only (provenance), not the dispatch key.
 *
 * On a classified non-retryable provider error (quota/auth/context-overflow/
 * fatal) or a timeout, the pipeline falls back to a shared DeterministicForker
 * (path D) rather than retrying — the same wall would be hit again.
 */

import { inject, injectable } from "tsyringe";
import { logger } from "@mcode/shared";
import { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import { WorkspaceRepo } from "../../projects/persistence/workspace-repo.js";
import { ToolCallRecordRepo } from "../../agents/tools/persistence/tool-call-record-repo.js";
import { ThoughtSegmentRepo } from "../../agents/conversation/narrative/persistence/thought-segment-repo.js";
import { classifyProviderError } from "./error-classifier.js";
import { buildHandoffPrompt } from "../artifacts/handoff-prompt.js";
import { DeterministicForker } from "../providers/session-forker.js";
import { buildConversationReplay } from "../artifacts/handoff-builder.js";
import type {
  ForkRequest,
  IAgentProvider,
  IProviderRegistry,
  ProviderId,
  ToolCallRecord,
  ThoughtSegmentRecord,
  Message,
  ForkHistoryBudget,
} from "@mcode/contracts";
/**
 * Render an Error-shaped value for structured logging. Winston cannot
 * serialize Error.message / Error.stack because they are non-enumerable;
 * this returns a plain object with those fields plus any classifier-relevant
 * properties (code, status, name).
 */
function describeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      code: (err as { code?: string }).code,
      status: (err as { status?: number }).status,
    };
  }
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    return {
      value: obj,
      message: obj.message,
      code: obj.code,
      status: obj.status,
    };
  }
  return { value: String(err) };
}

import type {
  HandoffArtifact,
  HandoffRequest,
} from "../artifacts/handoff-types.js";

/**
 * Minimal structural interface for the repos needed by this service.
 * Sync or async return values are both accepted so tests can use
 * async mocks against the real sync repo methods.
 */
interface IThreadRepo {
  findById(id: string): Promise<any> | any;
}
interface IWorkspaceRepo {
  findById(id: string): Promise<any> | any;
}
interface IToolCallRecordRepo {
  listByMessage(messageId: string): Promise<ToolCallRecord[]> | ToolCallRecord[];
}
interface IThoughtSegmentRepo {
  listByMessage(messageId: string): Promise<ThoughtSegmentRecord[]> | ThoughtSegmentRecord[];
}

type PreparedForkContext = {
  parent: any;
  parentProvider: IAgentProvider | null;
  forkMsg: Message;
  parentCwd: string;
};

/**
 * How many of the parent thread's most recent assistant messages to mine for
 * tool-call / narration / files-changed signals when composing a deterministic
 * (path-D) handoff. Bounded so a long thread doesn't produce an unwieldy doc.
 */
const RECENT_ASSISTANT_MESSAGES_FOR_D = 5;

/**
 * Timeout for side-channel provider calls, in milliseconds.
 * Handoff generation includes a cold SDK subprocess start plus model inference;
 * 60s was too tight after server restarts on Windows.
 */
const PROVIDER_CALL_TIMEOUT_MS = 120_000;

/**
 * Character cap for the conversation-history replay used as the clean-resume
 * B-prime fallback body sent to the PARENT provider's side-channel. Sizes the
 * parent's resume input, not the child's delivery (which is off-band), so it is
 * a fixed generous value rather than a function of the child's per-turn window.
 */
const REPLAY_BUDGET_CHARS = 100_000;

function formatHistoryBudgetNotice(historyBudget?: ForkHistoryBudget): string | null {
  if (!historyBudget) return null;
  const lines: string[] = [];
  if (historyBudget.omittedBeforeCount > 0) {
    const suffix = historyBudget.omittedBeforeCount === 1 ? "" : "s";
    lines.push(
      `[${historyBudget.omittedBeforeCount} earlier message${suffix} elided because the fork history budget was reached]`,
    );
  }
  if (historyBudget.truncatedMessages.length > 0) {
    const suffix = historyBudget.truncatedMessages.length === 1 ? "" : "s";
    lines.push(`[${historyBudget.truncatedMessages.length} retained message${suffix} truncated by the fork history budget]`);
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

function prefixHistoryBudgetNotice(text: string, historyBudget?: ForkHistoryBudget): string {
  const notice = formatHistoryBudgetNotice(historyBudget);
  if (!notice) return text;
  return text ? `${notice}\n\n${text}` : notice;
}

function collectFilesChanged(messages: Message[]): string[] {
  const filesChanged: string[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    appendMessageFilesChanged(filesChanged, seen, message);
  }
  return filesChanged;
}

function appendMessageFilesChanged(
  target: string[],
  seen: Set<string>,
  message: Message,
): void {
  const filesChanged = (message as { files_changed?: unknown }).files_changed;
  if (!Array.isArray(filesChanged)) return;
  for (const file of filesChanged) {
    if (typeof file === "string" && !seen.has(file)) {
      seen.add(file);
      target.push(file);
    }
  }
}

@injectable()
export class HandoffPipelineService {
  /**
   * Cross-forker fallback. The pipeline delegates to a provider's own forker
   * first; on a classified non-retryable error or timeout it falls back to this
   * deterministic forker (path D).
   */
  private readonly deterministicForker = new DeterministicForker();

  constructor(
    @inject(ThreadRepo) private readonly threadRepo: IThreadRepo,
    @inject("IProviderRegistry") private readonly providerRegistry: Pick<IProviderRegistry, "resolve">,
    @inject(WorkspaceRepo) private readonly workspaceRepo: IWorkspaceRepo,
    @inject(ToolCallRecordRepo) private readonly toolCallRecordRepo: IToolCallRecordRepo,
    @inject(ThoughtSegmentRepo) private readonly thoughtSegmentRepo: IThoughtSegmentRepo,
  ) {}

  /**
   * Test-friendly factory that bypasses DI. Accepts a plain deps object so
   * unit tests can pass vi.fn() mocks without a container.
   */
  static forTesting(deps: {
    threadRepo: IThreadRepo;
    providerRegistry: Pick<IProviderRegistry, "resolve">;
    workspaceRepo?: IWorkspaceRepo;
    toolCallRecordRepo?: IToolCallRecordRepo;
    thoughtSegmentRepo?: IThoughtSegmentRepo;
  }): HandoffPipelineService {
    const svc = Object.create(HandoffPipelineService.prototype) as HandoffPipelineService;
    (svc as any).threadRepo = deps.threadRepo;
    (svc as any).providerRegistry = deps.providerRegistry;
    (svc as any).workspaceRepo = deps.workspaceRepo ?? {
      findById: async () => ({ path: process.cwd() }),
    };
    (svc as any).toolCallRecordRepo = deps.toolCallRecordRepo ?? {
      listByMessage: () => [],
    };
    (svc as any).thoughtSegmentRepo = deps.thoughtSegmentRepo ?? {
      listByMessage: () => [],
    };
    // Initialize instance fields that aren't set via the constructor (Object.create
    // bypasses field initializers).
    (svc as any).deterministicForker = new DeterministicForker();
    return svc;
  }

  /**
   * Orchestrates B->D. Returns a HandoffArtifact. The caller is responsible
   * for persisting it via HandoffStorage.write() so the orchestrator stays
   * free of disk I/O and is fully testable in isolation.
   */
  async orchestrate(req: HandoffRequest): Promise<HandoffArtifact> {
    const context = await this.prepareForkContext(req);
    const forkReq = await this.createForkRequest(req, context);

    // Providers that cannot fork a session (capability "unsupported") or a
    // clean-resume provider with no session id to resume go straight to the
    // deterministic forker. The DeterministicForker is also the cross-forker
    // fallback below.
    const canProviderFork = this.canProviderFork(context.parentProvider, forkReq.parentSdkSessionId ?? null);
    if (!canProviderFork) {
      return this.deterministicForker.fork({ ...forkReq, forkReason: null });
    }
    return this.runProviderFork(context.parentProvider!, forkReq, req.parentThreadId);
  }

  private async prepareForkContext(req: HandoffRequest): Promise<PreparedForkContext> {
    const parent = await this.threadRepo.findById(req.parentThreadId);
    if (!parent) throw new Error(`Parent thread ${req.parentThreadId} not found`);
    if (parent.deleted_at) throw new Error("Cannot fork from a deleted thread");
    const workspace = await this.workspaceRepo.findById(parent.workspace_id);
    if (!workspace) throw new Error(`Workspace ${parent.workspace_id} not found for parent thread`);
    const forkMsg = req.messagesUpToFork.find((message: any) => message.id === req.forkedFromMessageId);
    if (!forkMsg) throw new Error(`Fork message ${req.forkedFromMessageId} not in parent`);
    return {
      parent,
      parentProvider: this.tryResolveProvider(parent.provider),
      forkMsg,
      parentCwd: parent.worktree_path ?? workspace.path,
    };
  }

  private async createForkRequest(
    req: HandoffRequest,
    context: PreparedForkContext,
  ): Promise<ForkRequest> {
    const deterministicInputs = await this.gatherDeterministicInputs(
      context.parent,
      req.messagesUpToFork,
      context.forkMsg,
    );
    return {
      parentThreadId: req.parentThreadId,
      forkedFromMessageId: req.forkedFromMessageId,
      forkAnchorRole: req.forkAnchorRole,
      prompt: buildHandoffPrompt({
        forkAnchorRole: req.forkAnchorRole,
        parentThreadTitle: context.parent.title,
        forkMessageExcerpt: context.forkMsg.content,
        childProviderId: req.childProviderId,
        userFollowUpMessage: req.userFollowUpMessage,
      }),
      cwd: context.parentCwd,
      parentSdkSessionId: context.parent.sdk_session_id ?? null,
      conversationHistory: prefixHistoryBudgetNotice(
        buildConversationReplay(req.messagesUpToFork, REPLAY_BUDGET_CHARS, null),
        req.historyBudget,
      ),
      messagesUpToFork: req.messagesUpToFork,
      historyBudget: req.historyBudget,
      parentThread: context.parent,
      childThreadId: req.childThreadId,
      ...deterministicInputs,
    };
  }

  private canProviderFork(provider: IAgentProvider | null, sessionId: string | null): boolean {
    return provider?.sessionForkOnResume === "clean" && sessionId !== null;
  }

  private async runProviderFork(
    provider: IAgentProvider,
    forkReq: ForkRequest,
    parentThreadId: string,
  ): Promise<HandoffArtifact> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), PROVIDER_CALL_TIMEOUT_MS);
    try {
      const artifact = await provider.forker.fork({ ...forkReq, abortSignal: abort.signal });
      return {
        markdown: artifact.markdown,
        meta: { ...artifact.meta, mode: "full", characterCount: artifact.markdown.length },
      };
    } catch (error) {
      return this.handleProviderForkFailure(error, abort.signal, forkReq, parentThreadId);
    } finally {
      clearTimeout(timer);
    }
  }

  private handleProviderForkFailure(
    error: unknown,
    signal: AbortSignal,
    forkReq: ForkRequest,
    parentThreadId: string,
  ): Promise<HandoffArtifact> {
    if (signal.aborted) {
      logger.warn("Handoff provider fork timed out; falling to D", { threadId: parentThreadId });
      return this.deterministicForker.fork({ ...forkReq, forkReason: "transient" });
    }
    const classification = classifyProviderError(error);
    logger.warn("Handoff provider fork failed", { error: describeError(error), cls: classification, threadId: parentThreadId });
    return this.deterministicForker.fork({ ...forkReq, forkReason: classification });
  }

  /**
   * Gather the deterministic-handoff (path-D) signals that already exist in the
   * database: the parent thread's last compact summary, the fork-anchor message
   * body, recent tool-call / narration records, and the de-duplicated files
   * changed across recent messages. Returned as a partial ForkRequest so the
   * orchestrator can spread it onto the request. Failures degrade gracefully —
   * a missing record just means an omitted section, never a fork failure.
   */
  private async gatherDeterministicInputs(
    parent: any,
    messagesUpToFork: Message[],
    forkMsg: Message,
  ): Promise<Pick<ForkRequest, "compactSummary" | "forkAnchorBody" | "toolCallRecords" | "thoughtSegments" | "filesChanged">> {
    const compactSummary: string | null = parent.last_compact_summary ?? null;
    const forkAnchorBody: string | null = forkMsg?.content ?? null;

    // Mine the most recent assistant messages up to the fork for structured
    // activity. Tool calls / narration are keyed by assistant message id.
    const recentAssistant = messagesUpToFork
      .filter((m) => m.role === "assistant")
      .slice(-RECENT_ASSISTANT_MESSAGES_FOR_D);

    const { toolCallRecords, thoughtSegments } = await this.collectRecentNarrative(recentAssistant);
    const filesChanged = collectFilesChanged(messagesUpToFork);

    return { compactSummary, forkAnchorBody, toolCallRecords, thoughtSegments, filesChanged };
  }

  private async collectRecentNarrative(messages: Message[]): Promise<{
    toolCallRecords: ToolCallRecord[];
    thoughtSegments: ThoughtSegmentRecord[];
  }> {
    const toolCallRecords: ToolCallRecord[] = [];
    const thoughtSegments: ThoughtSegmentRecord[] = [];
    for (const message of messages) {
      toolCallRecords.push(...(await this.listToolCallRecords(message.id)));
      thoughtSegments.push(...(await this.listThoughtSegments(message.id)));
    }
    return { toolCallRecords, thoughtSegments };
  }

  private async listToolCallRecords(messageId: string): Promise<ToolCallRecord[]> {
    try {
      return await this.toolCallRecordRepo.listByMessage(messageId);
    } catch {
      return [];
    }
  }

  private async listThoughtSegments(messageId: string): Promise<ThoughtSegmentRecord[]> {
    try {
      return await this.thoughtSegmentRepo.listByMessage(messageId);
    } catch {
      return [];
    }
  }

  /**
   * Safely resolve a provider by ID. The real ProviderRegistry.resolve()
   * throws if the provider isn't registered; this wraps that into a nullable
   * return so the orchestrator can gracefully degrade (typically to path D).
   */
  private tryResolveProvider(providerId: string): IAgentProvider | null {
    try {
      return this.providerRegistry.resolve(providerId as ProviderId);
    } catch {
      return null;
    }
  }
}
