import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";

/** Version of the private workspace environment document. */
export const WORKSPACE_ENVIRONMENT_VERSION = "0.0.1" as const;
/** Maximum UTF-8 bytes accepted for one platform script. */
export const WORKSPACE_ENVIRONMENT_SCRIPT_MAX_BYTES = 32 * 1024;
/** Maximum UTF-8 bytes accepted for one platform command object. */
export const WORKSPACE_ENVIRONMENT_COMMAND_MAX_BYTES = 64 * 1024;
/** Maximum UTF-8 bytes accepted for the complete environment document. */
export const WORKSPACE_ENVIRONMENT_DOCUMENT_MAX_BYTES = 128 * 1024;

/** Stable validation reasons returned by the workspace environment boundary. */
export const WorkspaceEnvironmentValidationReasonSchema = z.enum([
  "unsupported_version",
  "empty_script",
  "script_too_large",
  "command_too_large",
  "document_too_large",
  "null_byte",
  "duplicate_action_id",
  "invalid_value",
]);
export type WorkspaceEnvironmentValidationReason = z.infer<
  typeof WorkspaceEnvironmentValidationReasonSchema
>;

/** A structured field-level workspace environment validation issue. */
export const WorkspaceEnvironmentValidationIssueSchema = z.object({
  path: z.array(z.union([z.string(), z.number()])),
  code: z.string().min(1),
  reason: WorkspaceEnvironmentValidationReasonSchema,
  message: z.string().min(1),
}).strict();
export type WorkspaceEnvironmentValidationIssue = z.infer<
  typeof WorkspaceEnvironmentValidationIssueSchema
>;

const scriptSchema = z.string().superRefine((value, ctx) => {
  if (value.includes("\0")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Scripts must not contain null bytes",
      params: { code: "NULL_BYTE", reason: "null_byte" },
    });
  }
  if (new TextEncoder().encode(value).byteLength > WORKSPACE_ENVIRONMENT_SCRIPT_MAX_BYTES) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Scripts must be at most ${WORKSPACE_ENVIRONMENT_SCRIPT_MAX_BYTES} bytes`,
      params: { code: "SCRIPT_TOO_LARGE", reason: "script_too_large" },
    });
  }
});

/** A Platform command with optional default and operating-system scripts. */
export const WorkspaceEnvironmentCommandSchema = lazySchema(() =>
  z.object({
    default: scriptSchema.optional(),
    windows: scriptSchema.optional(),
    macos: scriptSchema.optional(),
    linux: scriptSchema.optional(),
  }).strict().superRefine((command, ctx) => {
    const scripts = Object.values(command).filter((script): script is string =>
      typeof script === "string" && script.trim().length > 0,
    );
    if (scripts.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["default"],
        message: "A command must contain at least one non-empty script",
        params: { code: "EMPTY_SCRIPT", reason: "empty_script" },
      });
    }
    const bytes = new TextEncoder().encode(JSON.stringify(command)).byteLength;
    if (bytes > WORKSPACE_ENVIRONMENT_COMMAND_MAX_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Commands must be at most ${WORKSPACE_ENVIRONMENT_COMMAND_MAX_BYTES} bytes`,
        params: { code: "COMMAND_TOO_LARGE", reason: "command_too_large" },
      });
    }
  }),
);
export type WorkspaceEnvironmentCommand = z.infer<
  ReturnType<typeof WorkspaceEnvironmentCommandSchema>
>;

/** A named workspace environment action with an opaque stable identity. */
export const WorkspaceEnvironmentActionSchema = lazySchema(() =>
  z.object({
    id: z.string().min(1).max(256),
    name: z.string().trim().min(1).max(256),
    command: WorkspaceEnvironmentCommandSchema(),
  }).strict(),
);
export type WorkspaceEnvironmentAction = z.infer<
  ReturnType<typeof WorkspaceEnvironmentActionSchema>
>;

/** Private system-local workspace environment document. */
export const WorkspaceEnvironmentDocumentSchema = lazySchema(() =>
  z.object({
    version: z.string(),
    setup: WorkspaceEnvironmentCommandSchema().optional(),
    actions: z.array(WorkspaceEnvironmentActionSchema()).max(256),
  }).strict().superRefine((document, ctx) => {
    if (document.version !== WORKSPACE_ENVIRONMENT_VERSION) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["version"],
        message: `Unsupported workspace environment version: ${document.version}`,
        params: { code: "UNSUPPORTED_VERSION", reason: "unsupported_version" },
      });
    }
    const seen = new Set<string>();
    document.actions.forEach((action, index) => {
      if (seen.has(action.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["actions", index, "id"],
          message: `Action id must be unique: ${action.id}`,
          params: { code: "DUPLICATE_ACTION_ID", reason: "duplicate_action_id" },
        });
      }
      seen.add(action.id);
    });
    const bytes = new TextEncoder().encode(JSON.stringify(document)).byteLength;
    if (bytes > WORKSPACE_ENVIRONMENT_DOCUMENT_MAX_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Environment documents must be at most ${WORKSPACE_ENVIRONMENT_DOCUMENT_MAX_BYTES} bytes`,
        params: { code: "DOCUMENT_TOO_LARGE", reason: "document_too_large" },
      });
    }
  }),
);
export type WorkspaceEnvironmentDocument = z.infer<
  ReturnType<typeof WorkspaceEnvironmentDocumentSchema>
>;

/** Default document used before a workspace has a saved environment. */
export const DEFAULT_WORKSPACE_ENVIRONMENT_DOCUMENT: WorkspaceEnvironmentDocument = {
  version: WORKSPACE_ENVIRONMENT_VERSION,
  actions: [],
};

/** Result of reading a workspace environment, including its opaque revision. */
export const WorkspaceEnvironmentReadResultSchema = lazySchema(() =>
  z.object({
    document: WorkspaceEnvironmentDocumentSchema(),
    revision: z.string().nullable(),
    status: z.enum(["present", "absent"]),
  }).strict(),
);
export type WorkspaceEnvironmentReadResult = z.infer<
  ReturnType<typeof WorkspaceEnvironmentReadResultSchema>
>;

/** Request for replacing a workspace environment document. */
export const WorkspaceEnvironmentSaveInputSchema = lazySchema(() =>
  z.object({
    workspaceId: z.string().min(1).max(256),
    sourceRevision: z.string().nullable(),
    document: WorkspaceEnvironmentDocumentSchema(),
  }).strict(),
);
export type WorkspaceEnvironmentSaveInput = z.infer<
  ReturnType<typeof WorkspaceEnvironmentSaveInputSchema>
>;

/** Structured errors exposed by the workspace environment lifecycle boundary. */
export const WorkspaceEnvironmentErrorSchema = z.object({
  code: z.enum([
    "WORKSPACE_ENVIRONMENT_VALIDATION",
    "WORKSPACE_ENVIRONMENT_UNSUPPORTED_VERSION",
    "WORKSPACE_ENVIRONMENT_STALE",
    "WORKSPACE_ENVIRONMENT_NOT_FOUND",
  ]),
  message: z.string().min(1),
  issues: z.array(WorkspaceEnvironmentValidationIssueSchema).optional(),
}).strict();

/** Convert a Zod result into the stable field-level error shape used by transport. */
export function workspaceEnvironmentValidationIssues(
  error: z.ZodError,
): WorkspaceEnvironmentValidationIssue[] {
  return error.issues.map((issue) => {
    const params = "params" in issue && issue.params && typeof issue.params === "object"
      ? issue.params as Record<string, unknown>
      : {};
    const reason = WorkspaceEnvironmentValidationReasonSchema.safeParse(params.reason).success
      ? params.reason as WorkspaceEnvironmentValidationReason
      : "invalid_value";
    const code = typeof params.code === "string"
      ? params.code
      : issue.code === "unrecognized_keys"
        ? "UNKNOWN_KEY"
        : issue.code.toUpperCase();
    return {
      path: issue.path,
      code,
      reason,
      message: issue.message,
    };
  });
}
