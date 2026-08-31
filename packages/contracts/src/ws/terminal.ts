import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";
import {
  TERMINAL_MAX_CHECKPOINT_BYTES,
  TERMINAL_MAX_SESSIONS,
  TerminalAttachmentDescriptorSchema,
  type TerminalErrorCode,
  TerminalCustomProfileIdSchema,
  TerminalCustomProfileSchema,
  TerminalErrorSchema,
  TerminalProfileReferenceSchema,
  TerminalResolvedProfileSchema,
  TerminalScopeSchema,
  TerminalSessionSnapshotSchema,
  TerminalU64Schema,
  TerminalUuidSchema,
  TerminalV1BackendCapabilitiesSchema,
  type TerminalRetryClass,
} from "../models/terminal.js";
import {
  TerminalAccessibilitySettingsSchema,
  TerminalBehaviorSettingsSchema,
  TerminalPreferencesUpdateSchema,
  TerminalProfileRecoverySchema,
  TerminalPresentationSettingsSchema,
} from "../models/terminal-settings.js";
import {
  TerminalDiagnosticEventSchema,
  TerminalDiagnosticsBundleSchema,
} from "../models/terminal-diagnostics.js";

/** Maximum complete Terminal JSON RPC request bytes. */
export const TERMINAL_RPC_MAX_BYTES = 131_072;
/** Terminal checkpoint upload chunk size. */
export const TERMINAL_CHECKPOINT_CHUNK_BYTES = 65_536;
/** Terminal checkpoint upload expiry. */
export const TERMINAL_CHECKPOINT_EXPIRES_AFTER_MS = 10_000;

const TERMINAL_DIAGNOSTICS_RESPONSE_MAX_BYTES = 524_288 + 1_024;

/** Frozen Terminal v1 management method names. */
export const TERMINAL_V1_METHOD_NAMES = [
  "terminal.capabilities",
  "terminal.session.create",
  "terminal.session.list",
  "terminal.session.attach",
  "terminal.session.detach",
  "terminal.session.close",
  "terminal.session.hasChildren",
  "terminal.session.checkpoint.begin",
  "terminal.session.checkpoint.complete",
  "terminal.profile.list",
  "terminal.profile.create",
  "terminal.profile.update",
  "terminal.profile.delete",
  "terminal.profile.setDefault",
  "terminal.workspacePreferences.get",
  "terminal.workspacePreferences.update",
  "terminal.workspacePreferences.reset",
  "terminal.preferences.reset",
  "terminal.preferences.update",
  "terminal.diagnostics.report",
  "terminal.diagnostics.getBundle",
] as const;

/** Terminal v1 management method name. */
export type TerminalV1MethodName = (typeof TERMINAL_V1_METHOD_NAMES)[number];

type RetryPolicy = Partial<Record<TerminalErrorCode, TerminalRetryClass>>;
interface MethodContract {
  readonly params: z.ZodTypeAny;
  readonly result: z.ZodTypeAny;
  readonly errors: RetryPolicy;
  readonly unknownResult: "SAFE_RETRY" | "UNKNOWN_DELIVERY" | "REATTACH";
  readonly authority?: "checkpoint-upload";
}

const empty = z.object({}).strict();
const id = TerminalUuidSchema();
const u64 = TerminalU64Schema();
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const terminalProfileInput = TerminalCustomProfileSchema().omit({ id: true });
const terminalPreferencesResult = z
  .object({
    terminal: z
      .object({
        presentation: TerminalPresentationSettingsSchema(),
        behavior: TerminalBehaviorSettingsSchema(),
        accessibility: TerminalAccessibilitySettingsSchema(),
      })
      .strict(),
  })
  .strict();

const contract = (
  params: z.ZodTypeAny,
  result: z.ZodTypeAny,
  errors: RetryPolicy,
  unknownResult: MethodContract["unknownResult"],
  authority?: MethodContract["authority"],
): MethodContract => ({ params, result, errors, unknownResult, ...(authority ? { authority } : {}) });

/** Strict schemas and retry metadata for every Terminal v1 management method. */
export const TERMINAL_V1_METHODS = {
  "terminal.capabilities": contract(empty, TerminalV1BackendCapabilitiesSchema(), {
    HOST_STARTING: "SAFE_RETRY", HOST_UNHEALTHY: "SAFE_RETRY", BACKEND_RESTART_REQUIRED: "RESTART", PROTOCOL_MISMATCH: "RESTART",
  }, "SAFE_RETRY"),
  "terminal.session.create": contract(
    z.object({ scope: TerminalScopeSchema(), requestedProfileId: TerminalProfileReferenceSchema().optional(), replacesSessionId: id.optional() }).strict(),
    TerminalSessionSnapshotSchema().refine((value) => value.state === "running"),
    { INVALID_SCOPE: "NEW_SESSION", PROFILE_NOT_FOUND: "NEW_SESSION", PROFILE_UNAVAILABLE: "NEW_SESSION", SLOT_LIMIT_REACHED: "NEW_SESSION", HOST_STARTING: "SAFE_RETRY", HOST_UNHEALTHY: "NEW_SESSION", CONTAINMENT_FAILED: "NEW_SESSION", PROTOCOL_MISMATCH: "RESTART" },
    "UNKNOWN_DELIVERY",
  ),
  "terminal.session.list": contract(
    z.object({ scope: TerminalScopeSchema().optional() }).strict(),
    z
      .array(TerminalSessionSnapshotSchema())
      .max(TERMINAL_MAX_SESSIONS)
      .refine(
        (sessions) => sessions.every((session, index) => index === 0 || sessions[index - 1].createdAt <= session.createdAt),
        "Terminal sessions must be ordered by creation time",
      ),
    { PROTOCOL_MISMATCH: "RESTART" },
    "SAFE_RETRY",
  ),
  "terminal.session.attach": contract(
    z.object({ sessionId: id, attachmentId: id, hostGeneration: u64, lastOutputSeq: u64, lastCommandSeq: u64, checkpointSeq: u64.optional() }).strict(),
    TerminalAttachmentDescriptorSchema(),
    { SESSION_NOT_FOUND: "NEW_SESSION", SESSION_NOT_RUNNING: "NEW_SESSION", STALE_HOST_GENERATION: "REATTACH", STALE_ATTACHMENT: "REATTACH", REPLAY_GAP: "REATTACH", HOST_UNHEALTHY: "REATTACH", PROTOCOL_MISMATCH: "RESTART" },
    "REATTACH",
  ),
  "terminal.session.detach": contract(
    z.object({ sessionId: id, attachmentId: id, attachmentEpoch: u64, reason: z.enum(["hide", "switch", "disconnect"]) }).strict(),
    z.object({ detached: z.literal(true) }).strict(),
    { SESSION_NOT_FOUND: "SAFE_RETRY", STALE_ATTACHMENT: "SAFE_RETRY", PROTOCOL_MISMATCH: "RESTART" },
    "SAFE_RETRY",
  ),
  "terminal.session.close": contract(
    z.object({ sessionId: id, reason: z.enum(["user", "scope-reset", "workspace-delete", "app-shutdown"]) }).strict(),
    TerminalSessionSnapshotSchema().refine((value) => value.state === "exited" || value.state === "failed"),
    { SESSION_NOT_FOUND: "SAFE_RETRY", SESSION_NOT_RUNNING: "SAFE_RETRY", STALE_HOST_GENERATION: "SAFE_RETRY", HOST_UNHEALTHY: "SAFE_RETRY", CONTAINMENT_FAILED: "NEW_SESSION", EXIT_FLUSH_FAILED: "REATTACH", PROTOCOL_MISMATCH: "RESTART" },
    "SAFE_RETRY",
  ),
  "terminal.session.hasChildren": contract(
    z.object({ sessionId: id }).strict(), z.object({ hasChildren: z.boolean() }).strict(),
    { SESSION_NOT_FOUND: "SAFE_RETRY", HOST_UNHEALTHY: "SAFE_RETRY", PROTOCOL_MISMATCH: "RESTART" }, "SAFE_RETRY",
  ),
  "terminal.session.checkpoint.begin": contract(
    z.object({ sessionId: id, attachmentId: id, attachmentEpoch: u64, hostGeneration: u64, baseOutputSeq: u64, declaredBytes: z.number().int().min(1).max(TERMINAL_MAX_CHECKPOINT_BYTES), sha256 }).strict(),
    z.object({ uploadId: id, chunkBytes: z.literal(TERMINAL_CHECKPOINT_CHUNK_BYTES), expiresAfterMs: z.literal(TERMINAL_CHECKPOINT_EXPIRES_AFTER_MS) }).strict(),
    { SESSION_NOT_FOUND: "REATTACH", STALE_ATTACHMENT: "REATTACH", STALE_HOST_GENERATION: "REATTACH", CHECKPOINT_REJECTED: "REATTACH", PROTOCOL_MISMATCH: "RESTART" }, "REATTACH",
  ),
  "terminal.session.checkpoint.complete": contract(
    z.object({ sessionId: id, attachmentId: id, attachmentEpoch: u64, hostGeneration: u64, uploadId: id, totalBytes: z.number().int().min(1).max(TERMINAL_MAX_CHECKPOINT_BYTES), sha256 }).strict(),
    z.object({ accepted: z.literal(true), checkpointThroughSeq: u64 }).strict(),
    { SESSION_NOT_FOUND: "REATTACH", STALE_ATTACHMENT: "REATTACH", STALE_HOST_GENERATION: "REATTACH", CHECKPOINT_REJECTED: "REATTACH", PROTOCOL_MISMATCH: "RESTART" }, "UNKNOWN_DELIVERY", "checkpoint-upload",
  ),
  "terminal.profile.list": contract(
    empty,
    z.object({
      certified: z.array(TerminalResolvedProfileSchema()).max(32),
      custom: z.array(TerminalCustomProfileSchema()).max(32),
      recovery: TerminalProfileRecoverySchema().optional(),
    }).strict(),
    { PROTOCOL_MISMATCH: "RESTART" }, "SAFE_RETRY",
  ),
  "terminal.profile.create": contract(
    terminalProfileInput, TerminalCustomProfileSchema(),
    { PROFILE_UNAVAILABLE: "NEW_SESSION", SETTINGS_INVALID: "NEW_SESSION", SETTINGS_WRITE_BLOCKED: "RESTART", PROTOCOL_MISMATCH: "RESTART" }, "UNKNOWN_DELIVERY",
  ),
  "terminal.profile.update": contract(
    terminalProfileInput.extend({ profileId: TerminalCustomProfileIdSchema() }).strict(), TerminalCustomProfileSchema(),
    { PROFILE_NOT_FOUND: "NEW_SESSION", PROFILE_UNAVAILABLE: "NEW_SESSION", SETTINGS_INVALID: "NEW_SESSION", SETTINGS_WRITE_BLOCKED: "RESTART", PROTOCOL_MISMATCH: "RESTART" }, "UNKNOWN_DELIVERY",
  ),
  "terminal.profile.delete": contract(
    z.object({ profileId: TerminalCustomProfileIdSchema() }).strict(), z.object({ deleted: z.literal(true) }).strict(),
    { PROFILE_NOT_FOUND: "SAFE_RETRY", PROFILE_IN_USE: "NEW_SESSION", SETTINGS_WRITE_BLOCKED: "RESTART", PROTOCOL_MISMATCH: "RESTART" }, "UNKNOWN_DELIVERY",
  ),
  "terminal.profile.setDefault": contract(
    z.object({ profileId: TerminalProfileReferenceSchema() }).strict(), z.object({ defaultProfileId: TerminalProfileReferenceSchema() }).strict(),
    { PROFILE_NOT_FOUND: "NEW_SESSION", SETTINGS_INVALID: "NEW_SESSION", SETTINGS_WRITE_BLOCKED: "RESTART", PROTOCOL_MISMATCH: "RESTART" }, "UNKNOWN_DELIVERY",
  ),
  "terminal.workspacePreferences.get": contract(
    z.object({ workspaceId: id }).strict(), z.object({ workspaceId: id, defaultProfileId: TerminalProfileReferenceSchema().nullable() }).strict(),
    { WORKSPACE_NOT_FOUND: "NEW_SESSION", PROTOCOL_MISMATCH: "RESTART" }, "SAFE_RETRY",
  ),
  "terminal.workspacePreferences.update": contract(
    z.object({ workspaceId: id, defaultProfileId: TerminalProfileReferenceSchema() }).strict(), z.object({ workspaceId: id, defaultProfileId: TerminalProfileReferenceSchema() }).strict(),
    { WORKSPACE_NOT_FOUND: "NEW_SESSION", PROFILE_NOT_FOUND: "NEW_SESSION", SETTINGS_INVALID: "NEW_SESSION", PROTOCOL_MISMATCH: "RESTART" }, "UNKNOWN_DELIVERY",
  ),
  "terminal.workspacePreferences.reset": contract(
    z.object({ workspaceId: id }).strict(), z.object({ reset: z.literal(true) }).strict(),
    { WORKSPACE_NOT_FOUND: "SAFE_RETRY", PROTOCOL_MISMATCH: "RESTART" }, "SAFE_RETRY",
  ),
  "terminal.preferences.reset": contract(
    z.object({ workspaceId: id.optional() }).strict(), z.object({ reset: z.literal(true) }).strict(),
    { SETTINGS_WRITE_BLOCKED: "RESTART", SETTINGS_INVALID: "NEW_SESSION", PROTOCOL_MISMATCH: "RESTART" }, "UNKNOWN_DELIVERY",
  ),
  "terminal.preferences.update": contract(
    TerminalPreferencesUpdateSchema(), terminalPreferencesResult,
    { SETTINGS_INVALID: "NEW_SESSION", SETTINGS_WRITE_BLOCKED: "RESTART", PROTOCOL_MISMATCH: "RESTART" }, "UNKNOWN_DELIVERY",
  ),
  "terminal.diagnostics.report": contract(
    z.object({ events: z.array(TerminalDiagnosticEventSchema()).max(128) }).strict().refine(
      (value) => new TextEncoder().encode(JSON.stringify(value)).length <= 65_536,
      "Diagnostics report exceeds 64 KiB",
    ),
    z.object({ accepted: z.number().int().min(0).max(128) }).strict(),
    { PROTOCOL_MISMATCH: "RESTART" }, "SAFE_RETRY",
  ),
  "terminal.diagnostics.getBundle": contract(
    empty,
    TerminalDiagnosticsBundleSchema().refine(
      (value) => new TextEncoder().encode(JSON.stringify(value)).length <= 524_288,
      "Diagnostics bundle exceeds 512 KiB",
    ),
    { PROTOCOL_MISMATCH: "RESTART" },
    "SAFE_RETRY",
  ),
} as const satisfies Record<TerminalV1MethodName, MethodContract>;

/** Strict discriminated request schema for all Terminal v1 methods. */
export const TerminalRpcRequestSchema = lazySchema(() => {
  const variants: z.ZodDiscriminatedUnionOption<"method">[] = [];
  for (const method of TERMINAL_V1_METHOD_NAMES) {
    variants.push(z.object({ id, method: z.literal(method), params: TERMINAL_V1_METHODS[method].params }).strict());
  }
  return z.discriminatedUnion(
    "method",
    variants as unknown as [z.ZodDiscriminatedUnionOption<"method">, ...z.ZodDiscriminatedUnionOption<"method">[]],
  ).refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).length <= TERMINAL_RPC_MAX_BYTES,
    "Terminal request exceeds 128 KiB",
  );
});

/** Parses one size-bounded raw Terminal v1 management request. */
export function parseTerminalRpcRequest(raw: string): z.infer<ReturnType<typeof TerminalRpcRequestSchema>> {
  if (new TextEncoder().encode(raw).length > TERMINAL_RPC_MAX_BYTES) {
    throw new Error("Terminal request exceeds 128 KiB");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Terminal request is not valid JSON");
  }
  return TerminalRpcRequestSchema().parse(value);
}

const terminalRpcResponseSchemas = new Map<TerminalV1MethodName, () => z.ZodTypeAny>();

/** Returns the cached strict response envelope schema for one Terminal v1 method. */
export function TerminalRpcResponseSchema(method: TerminalV1MethodName): z.ZodTypeAny {
  let schema = terminalRpcResponseSchemas.get(method);
  if (!schema) {
    schema = lazySchema(() => {
      const methodContract = TERMINAL_V1_METHODS[method];
      const methodError = TerminalErrorSchema().superRefine((error, context) => {
        const expectedRetry = methodContract.errors[error.code];
        if (expectedRetry === undefined) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Error ${error.code} is not valid for ${method}`,
          });
        } else if (error.retry !== expectedRetry) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Error ${error.code} requires retry class ${expectedRetry}`,
          });
        }
      });
      const maxResponseBytes = method === "terminal.diagnostics.getBundle"
        ? TERMINAL_DIAGNOSTICS_RESPONSE_MAX_BYTES
        : TERMINAL_RPC_MAX_BYTES;
      return z.union([
        z.object({ id, result: methodContract.result }).strict(),
        z.object({ id, error: methodError }).strict(),
      ]).refine(
        (value) => new TextEncoder().encode(JSON.stringify(value)).length <= maxResponseBytes,
        `Terminal response exceeds ${maxResponseBytes} bytes`,
      );
    });
    terminalRpcResponseSchemas.set(method, schema);
  }
  return schema();
}
