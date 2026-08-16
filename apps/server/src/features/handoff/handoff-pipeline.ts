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
import { ThreadRepo } from "../../repositories/thread-repo.js";
import { WorkspaceRepo } from "../../repositories/workspace-repo.js";
import { ToolCallRecordRepo } from "../../repositories/tool-call-record-repo.js";
import { ThoughtSegmentRepo } from "../../repositories/thought-segment-repo.js";
import { classifyProviderError } from "./error-classifier.js";
import { buildHandoffPrompt } from "./handoff-prompt.js";
import { DeterministicForker } from "./session-forker.js";
import { buildConversationReplay } from "./handoff-builder.js";
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
} from "./handoff-types.js";

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
    const parent = await this.threadRepo.findById(req.parentThreadId);
    if (!parent) throw new Error(`Parent thread ${req.parentThreadId} not found`);
    if (parent.deleted_at) throw new Error("Cannot fork from a deleted thread");

    const workspace = await this.workspaceRepo.findById(parent.workspace_id);
    if (!workspace) throw new Error(`Workspace ${parent.workspace_id} not found for parent thread`);
    // Use worktree_path when the parent is running in a worktree; otherwise the
    // workspace root. This ensures the side-channel SDK call sees the user's
    // project files instead of the server's own working directory.
    const parentCwd: string = parent.worktree_path ?? workspace.path;

    const parentProvider = this.tryResolveProvider(parent.provider);
    const messagesUpToFork = req.messagesUpToFork;
    const forkIndex = messagesUpToFork.findIndex((m: any) => m.id === req.forkedFromMessageId);
    if (forkIndex === -1) throw new Error(`Fork message ${req.forkedFromMessageId} not in parent`);
    const forkMsg = messagesUpToFork[forkIndex];

    const prompt = buildHandoffPrompt({
      forkAnchorRole: req.forkAnchorRole,
      parentThreadTitle: parent.title,
      forkMessageExcerpt: forkMsg.content,
      childProviderId: req.childProviderId,
      userFollowUpMessage: req.userFollowUpMessage,
    });

    const capability: string = parentProvider?.sessionForkOnResume ?? "unsupported";
    const parentSdkSession: string | null = parent.sdk_session_id ?? null;

    // Build a budgeted history replay so that if a clean-resume session fails
    // (e.g. after a server restart), the provider can retry without `resume:`
    // and still produce a high-fidelity path-B result. This budget sizes the
    // PARENT provider's side-channel resume body (not the child's delivery,
    // which is off-band), so it is a fixed generous cap rather than a function
    // of the child provider's per-turn input window.
    const conversationHistory = prefixHistoryBudgetNotice(
      buildConversationReplay(messagesUpToFork, REPLAY_BUDGET_CHARS, null),
      req.historyBudget,
    );

    // Pre-gather the deterministic (path-D) signals from the parent thread so
    // DeterministicForker stays stateless. These are no-ops for provider paths
    // (path B) since the clean forker ignores the extra fields.
    const deterministicInputs = await this.gatherDeterministicInputs(parent, messagesUpToFork, forkMsg);

    const forkReq: ForkRequest = {
      parentThreadId: req.parentThreadId,
      forkedFromMessageId: req.forkedFromMessageId,
      forkAnchorRole: req.forkAnchorRole,
      prompt,
      cwd: parentCwd,
      parentSdkSessionId: parentSdkSession,
      conversationHistory,
      messagesUpToFork,
      historyBudget: req.historyBudget,
      parentThread: parent,
      childThreadId: req.childThreadId,
      ...deterministicInputs,
    };

    // Providers that cannot fork a session (capability "unsupported") or a
    // clean-resume provider with no session id to resume go straight to the
    // deterministic forker. The DeterministicForker is also the cross-forker
    // fallback below.
    const canProviderFork = !!parentProvider && capability === "clean" && !!parentSdkSession;
    if (!canProviderFork) {
      return this.deterministicForker.fork({ ...forkReq, forkReason: null });
    }

    const runFork = async (): Promise<HandoffArtifact> => {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), PROVIDER_CALL_TIMEOUT_MS);
      try {
        // Off-band delivery (PRD #538): the full doc ships to the child via a
        // temp file, so there is no inline budget to enforce here. Return the
        // provider's markdown verbatim with the constant "full" mode.
        const artifact = await parentProvider!.forker.fork({ ...forkReq, abortSignal: abort.signal });
        return {
          markdown: artifact.markdown,
          meta: { ...artifact.meta, mode: "full", characterCount: artifact.markdown.length },
        };
      } catch (err) {
        if ((abort.signal as AbortSignal).aborted) {
          logger.warn("Handoff provider fork timed out; falling to D", { threadId: req.parentThreadId });
          return this.deterministicForker.fork({ ...forkReq, forkReason: "transient" });
        }
        const cls = classifyProviderError(err);
        logger.warn("Handoff provider fork failed", { error: describeError(err), cls, threadId: req.parentThreadId });
        return this.deterministicForker.fork({ ...forkReq, forkReason: cls });
      } finally {
        clearTimeout(timer);
      }
    };

    return runFork();
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

    const toolCallRecords: ToolCallRecord[] = [];
    const thoughtSegments: ThoughtSegmentRecord[] = [];
    for (const m of recentAssistant) {
      try {
        toolCallRecords.push(...(await this.toolCallRecordRepo.listByMessage(m.id)));
      } catch {
        // Tolerate repo errors; the section is simply omitted.
      }
      try {
        thoughtSegments.push(...(await this.thoughtSegmentRepo.listByMessage(m.id)));
      } catch {
        // Tolerate repo errors; the section is simply omitted.
      }
    }

    // Aggregate files_changed across recent messages, de-duplicated and in
    // first-seen order. files_changed is stored as a JSON array of strings.
    const seen = new Set<string>();
    const filesChanged: string[] = [];
    for (const m of messagesUpToFork) {
      const fc = (m as { files_changed?: unknown }).files_changed;
      if (!Array.isArray(fc)) continue;
      for (const f of fc) {
        if (typeof f === "string" && !seen.has(f)) {
          seen.add(f);
          filesChanged.push(f);
        }
      }
    }

    return { compactSummary, forkAnchorBody, toolCallRecords, thoughtSegments, filesChanged };
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
