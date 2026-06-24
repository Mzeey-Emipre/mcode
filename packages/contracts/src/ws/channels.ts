import { z } from "zod";
import { AgentEventSchema } from "../events/agent-event.js";
import { ThreadStatusSchema } from "../models/enums.js";
import { SettingsSchema } from "../models/settings.js";
import { PlanQuestionSchema } from "../models/plan-questions.js";
import { PlanRecordSchema } from "../models/plan-output.js";
import { ChecksStatusSchema } from "../github.js";
import { PermissionRequestSchema, PermissionDecisionSchema } from "../models/permission.js";
import { ProviderAvailabilitySchema } from "../providers/availability.js";
import { lazySchema } from "../utils/lazySchema.js";

/** All push channel definitions keyed by channel name. */
export const WS_CHANNELS = {
  "agent.event": AgentEventSchema(),
  /**
   * @deprecated Legacy JSON format retained for backward compatibility.
   * Current servers send PTY output exclusively as binary WebSocket frames
   * using the `encodeTerminalDataFrame` envelope (tag 0x01); `broadcast()`
   * is never called for this channel. This schema only applies when a
   * client connects to an older server that still sends JSON terminal.data.
   */
  "terminal.data": lazySchema(() =>
    z.object({
      ptyId: z.string(),
      data: z.string(),
      /** Monotonic per-PTY sequence number. Absent from legacy clients/servers. */
      seq: z.number().int().nonnegative().optional(),
    }),
  )(),
  "terminal.exit": z.object({ ptyId: z.string(), code: z.number() }),
  "thread.status": z.object({
    threadId: z.string(),
    status: ThreadStatusSchema,
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
  "thread.checkoutChanged": z.object({
    threadId: z.string(),
    workspaceId: z.string(),
    branch: z.string(),
    checkoutState: z.enum(["named", "branchless"]),
    baseBranch: z.string().nullable(),
    prNumber: z.number().nullable(),
    prStatus: z.string().nullable(),
  }),
  "files.changed": z.object({
    workspaceId: z.string(),
    threadId: z.string().optional(),
  }),
  "settings.changed": SettingsSchema(),
  "skills.changed": z.object({}),
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
  "turn.persisted": z.object({
    threadId: z.string(),
    messageId: z.string(),
    toolCallCount: z.number(),
    filesChanged: z.array(z.string()),
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
