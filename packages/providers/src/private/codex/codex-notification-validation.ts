import { z } from "zod";

const text = z.string().max(1_048_576);
const requiredText = text.trim().min(1);
const identity = requiredText.max(512);
const position = z.object({ line: z.number().int().positive().safe(), column: z.number().int().positive().safe() });
const scoped = { threadId: identity, turnId: identity };
// Windows extended paths fit 32,767 UTF-16 code units; samples share the notice text budget.
const samplePaths = z.array(z.string().max(32_767)).max(1_024)
  .refine((paths) => paths.reduce((total, path) => total + path.length, 0) <= 1_048_576);

/** Native notice shapes from Codex app-server-protocol v2, before canonical projection. */
export const codexNoticeSchemas = {
  warning: z.object({ threadId: identity.nullish(), message: requiredText }),
  guardianWarning: z.object({ threadId: identity, message: requiredText }),
  "windows/worldWritableWarning": z.object({ samplePaths, extraCount: z.number().int().nonnegative().safe(), failedScan: z.boolean() }),
  "model/rerouted": z.object({ ...scoped, fromModel: requiredText, toModel: requiredText, reason: z.literal("highRiskCyberActivity") }),
  configWarning: z.object({ summary: requiredText, details: text.nullish(), path: text.nullish(), range: z.object({ start: position, end: position }).nullish() }),
  deprecationNotice: z.object({ summary: requiredText, details: text.nullish() }),
  "modelProvider/authRecoveryCompleted": z.object({ ...scoped, provider: requiredText, message: requiredText }),
};


const record = z.record(z.unknown());
const envelope = z.object({ jsonrpc: z.literal("2.0").optional(), method: z.string().min(1).max(4_096), params: record.default({}) });
const nativeId = z.string().min(1).max(4_096);
const routing = z.object({ threadId: nativeId.nullish(), turnId: nativeId.nullish(), itemId: nativeId.optional() }).passthrough();
const item = z.object({
  id: nativeId.optional(), type: z.string().min(1).max(128),
  text: z.string().optional(), role: z.string().optional(),
  content: z.array(z.union([z.string(), z.object({ type: z.string(), text: z.string().optional() }).passthrough()])).optional(),
  command: z.string().optional(), aggregatedOutput: z.string().nullish(), exitCode: z.number().int().nullish(),
  summary: z.array(z.string()).optional(), reasoningContent: z.array(z.string()).optional(),
  changes: z.array(z.object({ path: z.string(), kind: z.union([z.string(), record]) }).passthrough()).optional(),
  name: z.string().optional(), tool: z.string().optional(), server: z.string().optional(),
  receiverThreadIds: z.array(nativeId).optional(), agentThreadId: nativeId.optional(), agentPath: z.string().optional(),
}).passthrough();
const usage = z.object({ input_tokens: z.number().nonnegative().optional(), cached_input_tokens: z.number().nonnegative().optional(), output_tokens: z.number().nonnegative().optional() }).passthrough();
const turn = z.object({ id: nativeId.optional(), status: z.enum(["completed", "failed", "interrupted"]), error: z.object({ message: z.string() }).passthrough().nullish(), usage: usage.optional() }).passthrough();
const goal = z.object({
  threadId: nativeId, objective: z.string(), status: z.enum(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"]),
  tokenBudget: z.number().nonnegative().nullable(), tokensUsed: z.number().nonnegative(), timeUsedSeconds: z.number().nonnegative(),
  createdAt: z.number(), updatedAt: z.number(),
});
const delta = z.object({ delta: z.string(), threadId: z.string().optional(), itemId: z.string().optional() }).passthrough();
const approvalReview = z.object({ status: z.enum(["inProgress", "approved", "denied", "timedOut", "aborted"]), rationale: z.string().nullish() }).passthrough();
const approvalReviewStarted = z.object({ ...scoped, startedAtMs: z.number().finite(), reviewId: nativeId, targetItemId: nativeId.nullish(), review: approvalReview }).passthrough();
const approvalReviewCompleted = approvalReviewStarted.extend({ completedAtMs: z.number().finite() });
const strictReviewRequired = z.object({ ...scoped, startedAtMs: z.number().finite() }).passthrough();
const notificationEnvelope = z.object({ jsonrpc: z.literal("2.0") });
/** Preserve the relationship between each native method and its parsed parameters. */
function notificationSchema<M extends string, P extends z.ZodTypeAny>(method: M, params: P) {
  return notificationEnvelope.extend({ method: z.literal(method), params });
}

const knownNotificationSchema = z.discriminatedUnion("method", [
  notificationSchema("warning", codexNoticeSchemas.warning),
  notificationSchema("guardianWarning", codexNoticeSchemas.guardianWarning),
  notificationSchema("windows/worldWritableWarning", codexNoticeSchemas["windows/worldWritableWarning"]),
  notificationSchema("model/rerouted", codexNoticeSchemas["model/rerouted"]),
  notificationSchema("configWarning", codexNoticeSchemas.configWarning),
  notificationSchema("deprecationNotice", codexNoticeSchemas.deprecationNotice),
  notificationSchema("modelProvider/authRecoveryCompleted", codexNoticeSchemas["modelProvider/authRecoveryCompleted"]),
  notificationSchema("item/started", z.object({ item }).passthrough()),
  notificationSchema("item/completed", z.object({ item: item.optional() }).passthrough()),
  notificationSchema("item/autoApprovalReview/started", approvalReviewStarted),
  notificationSchema("item/autoApprovalReview/completed", approvalReviewCompleted),
  notificationSchema("autoApprovalReview/strictReviewRequired", strictReviewRequired),
  notificationSchema("item/agentMessage/delta", delta),
  notificationSchema("item/commandExecution/outputDelta", delta),
  notificationSchema("item/reasoning/textDelta", z.object({ delta: z.string().optional(), text: z.string().optional() }).passthrough()),
  notificationSchema("item/reasoning/summaryTextDelta", z.object({ delta: z.string().optional(), text: z.string().optional() }).passthrough()),
  notificationSchema("item/plan/delta", delta),
  notificationSchema("turn/started", z.object({ turn: z.object({ id: nativeId.optional() }).passthrough().optional() }).passthrough()),
  notificationSchema("turn/completed", z.object({ turn }).passthrough()),
  notificationSchema("turn/plan/updated", z.object({ plan: z.array(z.object({ step: z.string(), status: z.string() })), explanation: z.string().nullish() }).passthrough()),
  notificationSchema("thread/goal/updated", z.object({ goal }).passthrough()),
  notificationSchema("thread/settings/updated", z.object({ threadId: z.string() }).passthrough()),
  notificationSchema("mcpServer/startupStatus/updated", z.object({ name: z.string(), status: z.enum(["starting", "ready", "failed", "cancelled", "error"]) }).passthrough()),
  notificationSchema("error", z.object({ error: z.object({ message: z.string().optional() }).passthrough().optional(), willRetry: z.boolean().optional() }).passthrough()),
  notificationSchema("thread/started", record),
  notificationSchema("thread/goal/cleared", record),
  notificationSchema("account/updated", record),
  notificationSchema("account/rateLimits/updated", record),
]);
const knownMethods = new Set<string>(knownNotificationSchema.options.map((schema) => schema.shape.method.value));

/** A validated envelope whose method is outside the known payload schemas. */
export interface UnknownCodexNotification {
  jsonrpc: "2.0";
  method: string;
  params: Record<string, unknown>;
  unrecognized: true;
}

/** Native notifications retain schema-derived payload types and an explicit unknown variant. */
export type ValidatedCodexNotification =
  | (z.infer<typeof knownNotificationSchema> & { unrecognized?: false })
  | UnknownCodexNotification;

/** Validates the envelope and fields consumed by the adapter before any native state changes. */
export function parseCodexNotification(input: unknown): ValidatedCodexNotification | undefined {
  const parsed = envelope.safeParse(input);
  if (!parsed.success || !routing.safeParse(parsed.data.params).success) return undefined;
  const candidate = { ...parsed.data, jsonrpc: "2.0" as const };
  if (!knownMethods.has(candidate.method)) return { ...candidate, unrecognized: true };
  const known = knownNotificationSchema.safeParse(candidate);
  return known.success ? known.data : undefined;
}
