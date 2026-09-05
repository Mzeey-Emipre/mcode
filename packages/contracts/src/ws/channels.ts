import { z } from "zod";
import { AgentEventSchema } from "../events/agent-event.js";
import { CanonicalAgentEventEnvelopeSchema } from "../compat/agent-model.js";
import { ThreadStatusSchema } from "../models/enums.js";
import { ThreadSchema } from "../models/thread.js";
import { ProviderIdSchema, SettingsSchema } from "../models/settings.js";
import { PlanQuestionSchema } from "../models/plan-questions.js";
import { PlanRecordSchema } from "../models/plan-output.js";
import { ChecksStatusSchema } from "../github.js";
import { PermissionRequestSchema, PermissionDecisionSchema } from "../models/permission.js";
import { ProviderAvailabilitySchema } from "../providers/availability.js";
import { lazySchema } from "../utils/lazySchema.js";
import {
  BrowserAutomationHostDispatchTargetSchema,
  BrowserAutomationHostDispatchSchema,
  BrowserAutomationRequestSchema,
} from "../models/browser-automation.js";
import { TurnFileEffectSummarySchema } from "../models/file-effect.js";
import { TurnOutcomeSchema } from "../models/turn-outcome.js";
import { TurnSavingStatusSchema } from "../models/turn-runtime.js";
import { ProviderCatalogChangeSchema } from "../providers/capability-catalog.js";
import { ThreadObservedStateSchema } from "../thread-control.js";
import { WorkspaceEnvironmentActionRunSchema } from "../models/workspace-environment.js";
import { ThreadStartupSchema } from "../thread-startup.js";
import { LegacyTerminalChannels } from "./terminal-legacy.js";

/** Maximum canonical semantic events published in one durable batch. */
export const CANONICAL_AGENT_EVENT_BATCH_MAX = 256;

/** All push channel definitions keyed by channel name. */
export const WS_CHANNELS = {
  /** Directs browser creation to a host when no visible target exists yet. */
  "browserAutomation.bootstrap": z
    .object({
      hostId: z.string().min(1).max(256),
      generation: z.number().int().positive(),
      request: BrowserAutomationRequestSchema().refine(
        (request) => request.operation === "open",
        "Browser bootstrap only accepts open requests",
      ),
    })
    .strict(),
  /** Directs one scoped browser operation to a single registered renderer host. */
  "browserAutomation.request": z
    .object({
      hostId: z.string().min(1).max(256),
      generation: z.number().int().positive(),
      dispatch: BrowserAutomationHostDispatchSchema(),
    })
    .strict(),
  /** Directs cancellation of one in-flight browser operation to its renderer host. */
  "browserAutomation.cancel": z
    .object({
      hostId: z.string().min(1).max(256),
      generation: z.number().int().positive(),
      target: BrowserAutomationHostDispatchTargetSchema().optional(),
      requestId: z.string().min(1).max(256),
      sequence: z.number().int().nonnegative(),
      reason: z.enum(["deadline-exceeded", "client-disconnected", "provider-cancelled", "user-stopped"]),
    })
    .strict(),
  /** Settles every tab owned or claimed by one terminated provider session. */
  "browserAutomation.sessionRelease": z
    .object({
      hostId: z.string().min(1).max(256),
      generation: z.number().int().positive(),
      providerSessionId: z.string().min(1).max(256),
      reason: z.enum(["credential-revoked", "provider-session-ended"]),
    })
    .strict(),
  "agent.event": AgentEventSchema(),
  /** Canonical semantic batches published only after their durable transaction commits. */
  "agent.canonical": z.object({
    threadId: z.string().min(1),
    events: z.array(CanonicalAgentEventEnvelopeSchema).min(1).max(CANONICAL_AGENT_EVENT_BATCH_MAX),
  }).strict(),
  ...LegacyTerminalChannels(),
  "thread.status": z.object({
    threadId: z.string(),
    status: ThreadStatusSchema,
  }),
  /** Publishes a complete authoritative startup snapshot after each lifecycle change. */
  "thread.startup.updated": ThreadStartupSchema(),
  /** Publishes the latest retained result for one Project Action slot. */
  "workspace.environment.action.updated": z.object({
    threadId: z.string().min(1).max(256),
    actionId: z.string().min(1).max(256),
    runId: z.string().min(1).max(256),
    run: WorkspaceEnvironmentActionRunSchema(),
  }).strict(),
  /** Synchronizes durable user completion or reopen changes across clients. */
  "thread.lifecycleChanged": z.object({
    thread: ThreadSchema(),
  }),
  /** Removes a thread after successful automatic retention cleanup. */
  "thread.deleted": z.object({
    threadId: z.string(),
  }),
  "thread.prLinked": z.object({
    threadId: z.string(),
    prNumber: z.number(),
    prStatus: z.string(),
  }),
  "thread.checksUpdated": z.object({
    threadId: z.string(),
    checks: ChecksStatusSchema(),
  }),
  /** Emitted after the thread row's model (and active provider) are persisted for a send. */
  "thread.modelUpdated": z.object({
    threadId: z.string(),
    model: z.string(),
    provider: z.string(),
  }),
  /** Invalidates one canonical coordination projection after persisted control state changes. */
  "thread.controlChanged": z.object({
    workspaceId: z.string().min(1),
    threadId: z.string().min(1),
    state: ThreadObservedStateSchema(),
  }).strict(),
  "thread.checkoutChanged": lazySchema(() =>
    z.object({
      threadId: z.string(),
      workspaceId: z.string(),
      branch: z.string(),
      checkoutState: z.enum(["named", "branchless"]),
      baseBranch: z.string().nullable(),
      prNumber: z.number().nullable(),
      prStatus: z.string().nullable(),
    }),
  )(),
  "files.changed": z.object({
    workspaceId: z.string(),
    threadId: z.string().optional(),
  }),
  "settings.changed": SettingsSchema(),
  /** Invalidates only providers backed by the shared filesystem catalog. */
  "skills.changed": z.object({
    providerIds: z.array(ProviderIdSchema).min(1).max(6),
  }).strict(),
  /** Identity-based catalog changes produced by a completed background refresh. */
  "provider.catalogChanged": ProviderCatalogChangeSchema(),
  /** Full-list broadcast of provider availability. Replaces the client cache. */
  "providers.availability": z.array(ProviderAvailabilitySchema()),
  "branch.changed": lazySchema(() =>
    z.object({ workspaceId: z.string(), branch: z.string().nullable() }),
  )(),
  "workspace.gitStatusChanged": lazySchema(() =>
    z.object({ workspaceId: z.string(), isGitRepo: z.boolean() }),
  )(),
  /** Sidebar project order changed on the server; clients should refresh `workspace.list`. */
  "workspace.orderChanged": z.object({}),
  "turn.diffChanged": z.object({ threadId: z.string() }),
  "turn.persisted": z.object({
    threadId: z.string(),
    turnId: z.string().nullable().optional(),
    messageId: z.string(),
    toolCallCount: z.number(),
    filesChanged: z.array(z.string()),
    fileEffects: TurnFileEffectSummarySchema().optional(),
    outcome: TurnOutcomeSchema.optional(),
    executionId: z.string().nullable().optional(),
  }),
  /** Reports whether live assistant text remains recoverable or needs explicit risk acceptance. */
  "turn.savingStatus": TurnSavingStatusSchema(),
  /** Live net file effects attributed to explicit agent mutation tools. */
  "turn.fileEffectsUpdated": z.object({
    threadId: z.string(),
    turnId: z.string(),
    summary: TurnFileEffectSummarySchema(),
  }),
  /** Emitted when the model proposes a batch of clarifying questions in plan mode. */
  "plan.questions": z.object({
    threadId: z.string(),
    questions: z.array(PlanQuestionSchema()),
  }),
  /**
   * Emitted after the user submits answers and the plan-questions answered
   * marker is committed. Lets multi-tab clients on the same thread hide the
   * wizard without a full reload. Carries the "submission" semantics so the
   * AnsweredSummary marker can play its one-shot echo on receipt.
   */
  "plan.answered": z.object({
    threadId: z.string(),
    assistantMessageId: z.string(),
  }),
  /**
   * Emitted when the user dismisses the wizard via cancel. Settles the batch
   * on the receiving client (same answered-set update as `plan.answered`)
   * but intentionally distinct so the celebratory echo animation does NOT
   * play on other tabs — the user did not submit, they cancelled.
   */
  "plan.dismissed": z.object({
    threadId: z.string(),
    assistantMessageId: z.string(),
  }),
  /** Emitted when the agent generates a structured plan output. */
  "plan.generated": z.object({
    threadId: z.string(),
    plan: PlanRecordSchema(),
  }),
  /** A tool permission request awaiting user decision. */
  "permission.request": PermissionRequestSchema(),
  /** Notification that a permission request has been settled. */
  "permission.resolved": z.object({
    requestId: z.string(),
    decision: PermissionDecisionSchema,
  }),
  /** Emitted when a workspace is fully hard-deleted (all cleanup complete). */
  "workspace.deleted": z.object({ workspaceId: z.string() }),
  /** Emitted when a workspace deletion is permanently stuck after max retries. */
  "workspace.deleteFailed": z.object({
    workspaceId: z.string(),
    workspacePath: z.string(),
    reason: z.string(),
  }),
  /**
   * Emitted when a child thread's handoff transitions through generating, ready,
   * fallback (deterministic), or error states. Lets the UI reflect handoff progress
   * without polling.
   */
  "thread.handoff": z.object({
    threadId: z.string(),
    status: z.enum(["generating", "ready", "fallback", "error"]),
    ladderStep: z.enum(["B", "D"]).optional(),
    providerErrorOnGenerate: z
      .enum(["quota", "auth", "context-overflow", "transient", "fatal"])
      .nullable()
      .optional(),
  }),
} as const;

/** Union of all push channel names. */
export type WsChannelName = keyof typeof WS_CHANNELS;
