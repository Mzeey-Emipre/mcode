import { z } from "zod";
import { WorkspaceSchema, WorkspaceEnrichmentSchema } from "../models/workspace.js";
import { ThreadSchema, RecentThreadSchema } from "../models/thread.js";
import { ThreadModeSchema, PermissionModeSchema, InteractionModeSchema } from "../models/enums.js";
import { PaginatedMessagesSchema } from "../models/message.js";
import { AttachmentMetaSchema } from "../models/attachment.js";
import { MAX_ATTACHMENTS } from "../models/file-types.js";
import { ToolCallRecordSchema } from "../models/tool-call-record.js";
import { ThoughtSegmentRecordSchema } from "../models/thought-segment.js";
import { HookExecutionRecordSchema } from "../models/hook-execution.js";
import { NarrativeEntrySchema, TurnRangeSchema } from "../models/narrative-entry.js";
import { GitBranchSchema, WorktreeSchema } from "../git.js";
import { GitCommitSchema } from "../models/git-commit.js";
import { PrInfoSchema, PrDetailSchema, PrDraftSchema, CreatePrResultSchema, ChecksStatusSchema } from "../github.js";
import { SkillInfoSchema, SkillDiagnosticsSchema } from "../skills.js";
import { TurnSnapshotSchema } from "../models/turn-snapshot.js";
import { PlanAnswerSchema } from "../models/plan-questions.js";
import { PlanStatusSchema, PlanRecordSchema, PlanActionSchema } from "../models/plan-output.js";
import { DiffStatsSchema } from "../models/diff-stats.js";
import {
  SettingsSchema,
  PartialSettingsSchema,
  ReasoningLevelSchema,
  ProviderIdSchema,
  ContextWindowModeSchema,
} from "../models/settings.js";
import { lazySchema } from "../utils/lazySchema.js";
import { ProviderModelInfoSchema } from "../providers/models.js";
import { ProviderUsageInfoSchema } from "../providers/usage.js";
import { ProviderAvailabilitySchema } from "../providers/availability.js";
import { CopilotSubagentSchema, CopilotAgentNameSchema } from "../providers/copilot-agent.js";
import { PermissionDecisionSchema, PermissionRequestSchema } from "../models/permission.js";

/** Schema for creating a new thread. */
export const CreateThreadSchema = lazySchema(() =>
  z.object({
    workspaceId: z.string(),
    title: z.string(),
    mode: ThreadModeSchema,
    branch: z.string(),
  }),
);

/** Schema for sending a message to an existing thread. */
export const SendMessageSchema = lazySchema(() =>
  z.object({
    threadId: z.string(),
    content: z.string(),
    /**
     * When set, persisted user row uses this transcript while {@link content}
     * flows to providers (injections and hidden metadata fences).
     */
    displayContent: z.string().optional(),
    model: z.string().optional(),
    permissionMode: PermissionModeSchema.optional(),
    attachments: z.array(AttachmentMetaSchema).max(MAX_ATTACHMENTS).optional(),
    reasoningLevel: ReasoningLevelSchema.optional(),
    provider: ProviderIdSchema.optional(),
    /** When "plan", the server wraps the message with the plan-mode question prompt. */
    interactionMode: InteractionModeSchema.optional(),
    /** USD budget cap for this session. 0 or absent disables. */
    maxBudgetUsd: z.number().nonnegative().finite().optional(),
    /** Maximum agent turns. 0 or absent disables. */
    maxTurns: z.number().int().nonnegative().optional(),
    /** Copilot sub-agent to activate for this message. Ignored by other providers. */
    copilotAgent: CopilotAgentNameSchema.optional(),
    /** Context window tier ("200k" default, "1m" extended). Honored only by 1M-capable Claude models. */
    contextWindow: ContextWindowModeSchema.optional(),
    /** Boolean thinking toggle. Honored only by models with a thinking toggle (Haiku 4.5). */
    thinking: z.boolean().optional(),
    /**
     * Codex: fast service tier for this message. When set, persisted on the
     * thread like other per-send composer overrides. Undefined uses thread row
     * then global default.
     */
    codexFastMode: z.boolean().optional(),
    /** ID of the message being replied to. */
    replyToMessageId: z.string().uuid().optional(),
    /** Highlighted text excerpt from the original message. Absent for full-message replies. */
    quotedText: z.string().max(2000).optional(),
    /**
     * Plan-tab action hint. `revise` arms plan-output capture; `implement` runs
     * in chat mode without the plan-questions wrapper.
     */
    planAction: PlanActionSchema().optional(),
  }),
);

/** Schema for creating a thread and sending a message in one call. */
export const CreateAndSendSchema = lazySchema(() =>
  z.object({
    workspaceId: z.string(),
    content: z.string(),
    displayContent: z.string().optional(),
    model: z.string(),
    permissionMode: PermissionModeSchema.optional(),
    mode: ThreadModeSchema.optional(),
    branch: z.string().optional(),
    existingWorktreePath: z.string().optional(),
    attachments: z.array(AttachmentMetaSchema).max(MAX_ATTACHMENTS).optional(),
    reasoningLevel: ReasoningLevelSchema.optional(),
    provider: ProviderIdSchema.optional(),
    /** When "plan", the server wraps the message with the plan-mode question prompt. */
    interactionMode: InteractionModeSchema.optional(),
    /** USD budget cap for this session. 0 or absent disables. */
    maxBudgetUsd: z.number().nonnegative().finite().optional(),
    /** Maximum agent turns. 0 or absent disables. */
    maxTurns: z.number().int().nonnegative().optional(),
    /** Copilot sub-agent to activate for this thread. Ignored by other providers. */
    copilotAgent: CopilotAgentNameSchema.optional(),
    /** Context window tier ("200k" default, "1m" extended). Honored only by 1M-capable Claude models. */
    contextWindow: ContextWindowModeSchema.optional(),
    /** Boolean thinking toggle. Honored only by models with a thinking toggle (Haiku 4.5). */
    thinking: z.boolean().optional(),
    /**
     * Codex: persist fast tier on the new thread before the first message.
     * Undefined leaves `codex_fast_mode` null (inherit global on each turn).
     */
    codexFastMode: z.boolean().optional(),
    /** Source thread ID when branching from an existing thread. */
    parentThreadId: z.string().optional(),
    /** Fork-point message ID in the parent thread. Defaults to last persisted message. */
    forkedFromMessageId: z.string().optional(),
  }).refine(
  (d) => !d.forkedFromMessageId || d.parentThreadId,
  { message: "forkedFromMessageId requires parentThreadId", path: ["forkedFromMessageId"] },
  ),
);

/** Result schema for agent.createAndSend: a Thread with optional non-fatal warnings. */
export const CreateAndSendResultSchema = lazySchema(() =>
  ThreadSchema().extend({
    warnings: z.array(z.string()).optional(),
  }),
);

/** Thread with optional non-fatal warnings from worktree creation. */
export type CreateAndSendResult = z.infer<ReturnType<typeof CreateAndSendResultSchema>>;

/** All RPC method definitions keyed by method name with params and result schemas. */
export const WS_METHODS = lazySchema(() => ({
  "workspace.list": {
    params: z.object({}),
    result: z.array(WorkspaceSchema()),
  },
  "workspace.create": {
    params: z.object({ name: z.string(), path: z.string() }),
    result: WorkspaceSchema(),
  },
  "workspace.delete": {
    params: z.object({ id: z.string() }),
    result: z.boolean(),
  },
  /** Hard-delete a workspace and all its data immediately, bypassing the cleanup queue. */
  "workspace.forceDelete": {
    params: z.object({ id: z.string() }),
    result: z.boolean(),
  },
  /** Pin or unpin a workspace in the project selector. */
  "workspace.pin": {
    params: z.object({ id: z.string(), pinned: z.boolean() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /** Remove a workspace from the recent/pinned list without deleting it. */
  "workspace.removeRecent": {
    params: z.object({ id: z.string() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /** Record that a workspace was just opened, updating its recency timestamp. */
  "workspace.touchLastOpened": {
    params: z.object({ id: z.string() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /** Move a workspace to a new zero-based index in the sidebar order. */
  "workspace.reorder": {
    params: z.object({ id: z.string(), newIndex: z.number().int().nonnegative() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /** Batch-fetch git + thread enrichment for up to 200 workspace ids. */
  "workspace.enrich": {
    params: z.object({ ids: z.array(z.string()).max(200) }),
    result: z.object({ items: z.array(WorkspaceEnrichmentSchema()) }),
  },
  /** Browse the host filesystem starting at the given path, for the folder picker. */
  "filesystem.browse": {
    params: z.object({ path: z.string() }),
    result: z.object({
      path: z.string(),
      parent: z.string().nullable(),
      entries: z.array(z.object({ name: z.string(), isDir: z.boolean() })),
    }),
  },
  "thread.list": {
    params: z.object({ workspaceId: z.string() }),
    result: z.array(ThreadSchema()),
  },
  /**
   * List the most recently active threads across ALL workspaces. Joined with
   * workspace name + path so the landing can render project context per row
   * without a follow-up enrich call.
   */
  "thread.recent": {
    params: z.object({ limit: z.number().int().positive().max(50).optional() }),
    result: z.array(RecentThreadSchema()),
  },
  "thread.create": {
    params: CreateThreadSchema(),
    result: ThreadSchema(),
  },
  "thread.delete": {
    params: z.object({
      threadId: z.string(),
      cleanupWorktree: z.boolean(),
    }),
    result: z.boolean(),
  },
  "thread.updateTitle": {
    params: z.object({ threadId: z.string(), title: z.string() }),
    result: z.boolean(),
  },
  "thread.updateSettings": {
    params: z.object({
      threadId: z.string(),
      reasoningLevel: ReasoningLevelSchema.optional(),
      interactionMode: InteractionModeSchema.optional(),
      permissionMode: PermissionModeSchema.optional(),
      /** Copilot-specific: name of the selected sub-agent. Pass null to clear back to provider default. */
      copilotAgent: CopilotAgentNameSchema.nullable().optional(),
      /** Context window tier persisted on the thread. Pass null to clear back to the global default. */
      contextWindow: ContextWindowModeSchema.nullable().optional(),
      /** Boolean thinking toggle persisted on the thread. Honored only for Haiku-class models. Pass null to clear. */
      thinking: z.boolean().nullable().optional(),
      /**
       * Codex fast API tier override. True = fast, false = standard, null clears so the thread
       * inherits `settings.provider.codex.fastMode`.
       */
      codexFastMode: z.boolean().nullable().optional(),
    }).refine(
      (data) =>
        data.reasoningLevel !== undefined ||
        data.interactionMode !== undefined ||
        data.permissionMode !== undefined ||
        data.copilotAgent !== undefined ||
        data.contextWindow !== undefined ||
        data.thinking !== undefined ||
        data.codexFastMode !== undefined,
      { message: "Must provide at least one setting to update" },
    ),
    result: z.boolean(),
  },
  "thread.markViewed": {
    params: z.object({ threadId: z.string() }),
    result: z.void(),
  },
  "thread.syncPrs": {
    params: z.object({ workspaceId: z.string() }),
    result: z.array(z.object({
      threadId: z.string(),
      /** null signals the PR was cleared from this thread (stale data removed). */
      prNumber: z.number().nullable(),
      prStatus: z.string().nullable(),
    })),
  },
  /** Search threads across all workspaces by title substring, with optional status/provider filters and sort order. */
  "thread.search": {
    params: z.object({
      query: z.string().max(500),
      filters: z.object({
        status: z.array(z.string()).max(20).optional(),
        provider: z.array(z.string()).max(20).optional(),
      }).optional(),
      sort: z.object({
        field: z.enum(["updated_at", "created_at", "title"]),
        direction: z.enum(["asc", "desc"]),
      }).optional(),
      limit: z.number().int().positive().max(200).optional(),
    }),
    result: z.object({
      threads: z.array(ThreadSchema()),
      workspaces: z.array(z.object({
        id: z.string(),
        name: z.string(),
        path: z.string(),
      })),
    }),
  },
  "git.listBranches": {
    params: z.object({ workspaceId: z.string() }),
    result: z.array(GitBranchSchema),
  },
  "git.currentBranch": {
    params: z.object({ workspaceId: z.string() }),
    result: z.string().nullable(),
  },
  "git.checkout": {
    params: z.object({ workspaceId: z.string(), branch: z.string() }),
    result: z.void(),
  },
  "git.listWorktrees": {
    params: z.object({ workspaceId: z.string() }),
    result: z.array(WorktreeSchema),
  },
  "git.fetchBranch": {
    params: z.object({
      workspaceId: z.string(),
      branch: z.string(),
      prNumber: z.number().optional(),
    }),
    result: z.void(),
  },
  "git.log": {
    params: z.object({
      workspaceId: z.string(),
      branch: z.string().optional(),
      baseBranch: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional(),
      threadId: z.string().optional(),
    }),
    result: z.array(GitCommitSchema),
  },
  "git.commitDiff": {
    params: z.object({
      workspaceId: z.string(),
      sha: z.string(),
      filePath: z.string().optional(),
      maxLines: z.number().int().positive().optional(),
    }),
    result: z.string(),
  },
  "git.commitFiles": {
    params: z.object({
      workspaceId: z.string(),
      sha: z.string(),
    }),
    result: z.array(z.string()),
  },
  "agent.send": {
    params: SendMessageSchema(),
    result: z.void(),
  },
  "agent.createAndSend": {
    params: CreateAndSendSchema(),
    result: CreateAndSendResultSchema(),
  },
  "agent.stop": {
    params: z.object({ threadId: z.string() }),
    result: z.void(),
  },
  "agent.activeCount": {
    params: z.object({}),
    result: z.number(),
  },
  "agent.listRunning": {
    params: z.object({}),
    result: z.array(z.string()),
  },
  "agent.answerQuestions": {
    params: z.object({
      threadId: z.string(),
      answers: z.array(PlanAnswerSchema()),
      permissionMode: PermissionModeSchema.optional(),
      reasoningLevel: ReasoningLevelSchema.optional(),
      contextWindow: ContextWindowModeSchema.optional(),
      thinking: z.boolean().optional(),
    }),
    result: z.void(),
  },
  /**
   * Durably mark the latest plan-questions batch for a thread as
   * settled without submitting answers. Used by the wizard's `cancel`
   * action so the wizard does NOT re-appear on subsequent reloads /
   * thread switches.
   */
  "agent.dismissPlanQuestions": {
    params: z.object({ threadId: z.string() }),
    result: z.void(),
  },
  /** Update the status of a persisted plan (e.g. accept or supersede). */
  "plan.updateStatus": {
    params: z.object({
      planId: z.string(),
      status: PlanStatusSchema(),
    }),
    result: z.void(),
  },
  "plan.list": {
    params: z.object({
      threadId: z.string(),
    }),
    result: z.array(PlanRecordSchema()),
  },
  "permission.respond": {
    params: z.object({
      requestId: z.string(),
      decision: PermissionDecisionSchema,
    }),
    result: z.void(),
  },
  /** Returns pending permission requests for a thread; used to re-hydrate the frontend after a WebSocket reconnect. */
  "permission.listPending": {
    params: z.object({ threadId: z.string() }),
    result: z.array(PermissionRequestSchema()),
  },
  "message.list": {
    params: z.object({
      threadId: z.string(),
      limit: z.number().int().min(1).max(1000),
      before: z.number().int().optional(),
    }),
    result: PaginatedMessagesSchema(),
  },
  "file.list": {
    params: z.object({
      workspaceId: z.string(),
      threadId: z.string().optional(),
    }),
    result: z.array(z.string()),
  },
  "file.read": {
    params: z.object({
      workspaceId: z.string(),
      relativePath: z.string(),
      threadId: z.string().optional(),
    }),
    result: z.string(),
  },
  "github.branchPr": {
    params: z.object({ branch: z.string(), cwd: z.string() }),
    result: PrInfoSchema().nullable(),
  },
  "github.listOpenPrs": {
    params: z.object({ workspaceId: z.string() }),
    result: z.array(PrDetailSchema()),
  },
  "github.prByUrl": {
    params: z.object({ url: z.string() }),
    result: PrDetailSchema().nullable(),
  },
  "git.push": {
    params: z.object({
      workspaceId: z.string(),
      branch: z.string(),
    }),
    result: z.object({ success: z.boolean() }),
  },
  "github.generatePrDraft": {
    params: z.object({
      workspaceId: z.string(),
      threadId: z.string(),
      baseBranch: z.string(),
    }),
    result: PrDraftSchema(),
  },
  "github.createPr": {
    params: z.object({
      workspaceId: z.string(),
      threadId: z.string(),
      title: z.string().max(256),
      body: z.string().max(65536),
      baseBranch: z.string(),
      isDraft: z.boolean().default(false),
    }),
    result: CreatePrResultSchema(),
  },
  "github.checkStatus": {
    params: z.object({
      threadId: z.string(),
      /** Bypass the watcher's staleness guard and always perform a live `gh pr checks` fetch. */
      force: z.boolean().optional(),
    }),
    result: ChecksStatusSchema(),
  },
  "config.discover": {
    params: z.object({ workspacePath: z.string() }),
    result: z.record(z.unknown()),
  },
  "skill.list": {
    params: z.object({
      cwd: z.string().optional(),
      providerId: z.string().optional(),
    }),
    result: z.array(SkillInfoSchema()),
  },
  "skill.diagnose": {
    params: z.object({ cwd: z.string().optional() }),
    result: SkillDiagnosticsSchema(),
  },
  "terminal.create": {
    params: z.object({ threadId: z.string() }),
    result: z.object({ ptyId: z.string(), shell: z.string().max(64) }),
  },
  "terminal.write": {
    params: z.object({
      ptyId: z.string(),
      /** Cap at 64 KB — well above any single keystroke burst or paste. */
      data: z.string().max(65_536),
    }),
    result: z.void(),
  },
  "terminal.resize": {
    params: z.object({
      ptyId: z.string(),
      cols: z.number().int().min(1).max(500),
      rows: z.number().int().min(1).max(500),
    }),
    result: z.void(),
  },
  "terminal.kill": {
    params: z.object({ ptyId: z.string() }),
    result: z.void(),
  },
  "terminal.pause": {
    params: z.object({ ptyId: z.string() }),
    result: z.void(),
  },
  "terminal.resume": {
    params: z.object({ ptyId: z.string() }),
    result: z.void(),
  },
  "terminal.killByThread": {
    params: z.object({ threadId: z.string() }),
    result: z.void(),
  },
  /**
   * Reattach to a PTY after a WebSocket reconnect.
   * The server replays buffered chunks (as binary frames) with seq > lastSeq,
   * then returns a flag indicating whether the replay window was exceeded.
   */
  "terminal.reattach": {
    params: z.object({
      ptyId: z.string(),
      /**
       * Last sequence number the client received before the disconnect.
       * Pass -1 when the client has seen no output (replay everything).
       */
      lastSeq: z.number().int().min(-1),
    }),
    result: z.object({
      /** True when eviction means the client may have missed output. */
      gapped: z.boolean(),
    }),
  },
  /** List all active PTY sessions on the server. Used during reconnect. */
  "terminal.listActive": {
    params: z.object({}),
    result: z.array(
      z.object({ ptyId: z.string(), threadId: z.string() }),
    ),
  },
  /**
   * Check whether a PTY has non-shell child processes currently running.
   * Used by the optional kill confirmation feature.
   */
  "terminal.hasChildren": {
    params: z.object({ ptyId: z.string() }),
    result: z.object({ hasChildren: z.boolean() }),
  },
  "app.version": {
    params: z.object({}),
    result: z.string(),
  },
  "toolCallRecord.list": {
    params: z.object({ messageId: z.string() }),
    result: z.array(ToolCallRecordSchema),
  },
  "toolCallRecord.listByParent": {
    params: z.object({ parentToolCallId: z.string() }),
    result: z.array(ToolCallRecordSchema),
  },
  /**
   * Single-source hydration for a thread's persisted narrative: returns one
   * chronologically-ordered list of entries (assistant message bodies, tool
   * calls, narration segments, hooks) interleaved by (sequence, sortOrder).
   * Replaces the race-prone `message.list` + `narrative.list` pair so reloaded
   * turns render in source order (Tool calls never precede the assistant body).
   */
  "turn.load": {
    params: z.object({ threadId: z.string(), range: TurnRangeSchema().optional() }),
    result: z.array(NarrativeEntrySchema()),
  },
  /** Replay the full persisted narrative (tools, thoughts, hooks) for an assistant message. */
  "narrative.list": {
    params: z.object({ messageId: z.string() }),
    result: z.object({
      tools: z.array(ToolCallRecordSchema),
      thoughts: z.array(ThoughtSegmentRecordSchema),
      hooks: z.array(HookExecutionRecordSchema),
    }),
  },
  "thread.getTasks": {
    params: z.object({ threadId: z.string() }),
    result: z
      .array(z.object({
        content: z.string(),
        status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
        group: z.string().optional(),
      }))
      .nullable(),
  },
  "snapshot.getDiff": {
    params: z.object({
      snapshotId: z.string(),
      filePath: z.string().optional(),
      maxLines: z.number().int().positive().optional(),
    }),
    result: z.string(),
  },
  "snapshot.getDiffStats": {
    params: z.object({ snapshotId: z.string() }),
    result: z.array(DiffStatsSchema()),
  },
  "snapshot.cleanup": {
    params: z.object({}),
    result: z.object({ removed: z.number() }),
  },
  "snapshot.listByThread": {
    params: z.object({ threadId: z.string() }),
    result: z.array(TurnSnapshotSchema),
  },
  "snapshot.getCumulativeDiff": {
    params: z.object({
      threadId: z.string(),
      filePath: z.string().optional(),
      maxLines: z.number().int().positive().optional(),
    }),
    result: z.string(),
  },
  "clipboard.saveFile": {
    params: z.object({
      /**
       * Base64-encoded file content. Optional when using binary WebSocket upload
       * (the payload arrives as a separate binary frame).
       */
      data: z.string().min(1).max(45_000_000).optional(),
      /** MIME type of the file (e.g. "application/pdf", "text/plain"). */
      mimeType: z.string().min(1).max(127),
      /** Display name for the file (e.g. "document.pdf"). No path separators allowed. */
      fileName: z
        .string()
        .min(1)
        .max(255)
        .refine(
          (v) => !/[/\\\0]/.test(v),
          "fileName must not contain path separators or null bytes",
        ),
    }),
    result: AttachmentMetaSchema,
  },
  "settings.get": {
    params: z.object({}),
    result: SettingsSchema(),
  },
  "settings.update": {
    params: PartialSettingsSchema(),
    result: SettingsSchema(),
  },
  "provider.listModels": {
    params: z.object({ providerId: ProviderIdSchema }),
    result: z.array(ProviderModelInfoSchema()),
  },
  "provider.getUsage": {
    params: z.object({ providerId: ProviderIdSchema }),
    result: ProviderUsageInfoSchema(),
  },
  "memory.setBackground": {
    params: z.object({ background: z.boolean() }),
    result: z.void(),
  },
  "provider.copilotAgents": {
    params: z.object({
      workspaceId: z.string(),
    }),
    result: z.array(CopilotSubagentSchema()),
  },
  "providers.listAvailability": {
    params: z.object({}),
    result: z.array(ProviderAvailabilitySchema()),
  },
  /** Retrieve the stored diff summary for a thread (null if none exists). */
  "diffSummary.get": {
    params: z.object({
      threadId: z.string(),
    }),
    result: z
      .object({
        id: z.string(),
        threadId: z.string(),
        content: z.string(),
        turnCount: z.number(),
        lastTurnId: z.string().nullable(),
        model: z.string(),
        createdAt: z.string(),
      })
      .nullable(),
  },
  /**
   * v1 stub for regenerating a handoff document via the live AI path.
   * Live regeneration is deferred to a follow-on plan.
   */
  "handoff.regenerate": {
    params: z.object({ threadId: z.string() }),
    result: z.object({ status: z.literal("not-implemented") }),
  },
  /**
   * Read the latest handoff artifact for a child thread.
   * Returns null when no handoff exists for the given thread.
   */
  "handoff.readLatest": {
    params: z.object({ threadId: z.string() }),
    result: z.object({
      markdown: z.string(),
      meta: z.object({
        schemaVersion: z.literal(1),
        parentThreadId: z.string(),
        forkedFromMessageId: z.string(),
        forkAnchorRole: z.enum(["user", "assistant"]),
        childThreadId: z.string(),
        generatedBy: z.enum(["provider", "deterministic"]),
        provider: z.string().nullable(),
        ladderStep: z.enum(["B", "D"]),
        mode: z.enum(["full", "minimal"]),
        generatedAt: z.string(),
        characterCount: z.number(),
        parentSdkSessionId: z.string().nullable(),
        providerErrorOnGenerate: z
          .enum(["quota", "auth", "context-overflow", "transient", "fatal", "clean"])
          .nullable(),
        regenerationHistory: z.array(z.object({
          at: z.string(),
          ladderStep: z.enum(["B", "D"]),
          reason: z.enum(["quota", "auth", "context-overflow", "transient", "fatal", "clean", "user-requested"]),
        })),
        attachments: z.array(z.object({
          id: z.string(),
          originalName: z.string(),
          sha256: z.string(),
          mime: z.string(),
          parentMessageId: z.string(),
        })),
      }),
    }).nullable(),
  },
  /** Generate (or regenerate) an AI-powered diff summary for a thread. */
  "diffSummary.generate": {
    params: z.object({
      threadId: z.string(),
    }),
    result: z.object({
      id: z.string(),
      threadId: z.string(),
      content: z.string(),
      turnCount: z.number(),
      lastTurnId: z.string().nullable(),
      model: z.string(),
      createdAt: z.string(),
    }),
  },
} as const));

/** Union of all RPC method names. */
export type WsMethodName = keyof ReturnType<typeof WS_METHODS>;
