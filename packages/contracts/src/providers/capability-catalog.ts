import { z } from "zod";
import { ProviderIdSchema } from "../models/settings.js";
import { SkillSourceSchema } from "../skills.js";
import { lazySchema } from "../utils/lazySchema.js";

/** Maximum accepted length for provider catalog paths. */
export const PROVIDER_CATALOG_PATH_MAX_CHARS = 4_096;
/** Maximum accepted provider catalog entries per snapshot. */
export const PROVIDER_CATALOG_MAX_ENTRIES = 2_000;
/** Maximum selectable provider agents returned per catalog snapshot. */
export const PROVIDER_CATALOG_MAX_SELECTABLE_AGENTS = 500;
/** Maximum source diagnostics returned per catalog snapshot. */
export const PROVIDER_CATALOG_MAX_DIAGNOSTICS = 100;
/** Maximum Codex agent files inspected while building one catalog snapshot. */
export const PROVIDER_CATALOG_MAX_CODEX_AGENT_FILES = 1_000;
/** Maximum bytes read from one Codex agent file during catalog discovery. */
export const PROVIDER_CATALOG_MAX_CODEX_AGENT_FILE_BYTES = 64 * 1_024;
/** Provider-native capability kinds represented in a catalog snapshot. */
export const ProviderCapabilityKindSchema = z.enum([
  "skill",
  "plugin",
  "customPrompt",
  "providerCommand",
]);
/** Provider-native capability kind represented in a catalog snapshot. */
export type ProviderCapabilityKind = z.infer<typeof ProviderCapabilityKindSchema>;

const CatalogNameSchema = z.string().trim().min(1).max(256);
const CatalogAgentNameSchema = CatalogNameSchema.refine(
  (name) => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(name),
  "Agent names cannot contain control characters",
);
const CatalogDescriptionSchema = z.string().max(2_000);
const CatalogNativeIdSchema = z.string().trim().min(1).max(512);
const CatalogPathSchema = z.string().min(1).max(PROVIDER_CATALOG_PATH_MAX_CHARS);
const CatalogMarketplaceNameSchema = z.string().trim().min(1).max(256);
const CatalogVersionSchema = z.string().trim().min(1).max(128);
const CatalogCapabilitySchema = z.string().trim().min(1).max(256);

const providerSkillIdentitySchema = lazySchema(() =>
  z.object({
    providerId: ProviderIdSchema,
    kind: z.literal("skill"),
    nativeId: CatalogNativeIdSchema,
  }).strict(),
);
const providerPluginIdentitySchema = lazySchema(() =>
  z.object({
    providerId: ProviderIdSchema,
    kind: z.literal("plugin"),
    nativeId: CatalogNativeIdSchema,
  }).strict(),
);
const providerCustomPromptIdentitySchema = lazySchema(() =>
  z.object({
    providerId: ProviderIdSchema,
    kind: z.literal("customPrompt"),
    nativeId: CatalogNativeIdSchema,
  }).strict(),
);
const providerCommandIdentitySchema = lazySchema(() =>
  z.object({
    providerId: ProviderIdSchema,
    kind: z.literal("providerCommand"),
    nativeId: CatalogNativeIdSchema,
  }).strict(),
);

/** Provider Skill entry available for explicit invocation. */
export const ProviderSkillCapabilitySchema = lazySchema(() =>
  z.object({
    kind: z.literal("skill"),
    identity: providerSkillIdentitySchema(),
    name: CatalogNameSchema,
    description: CatalogDescriptionSchema,
    source: SkillSourceSchema,
    nativeName: CatalogNameSchema.optional(),
    path: CatalogPathSchema.optional(),
  }).strict(),
);

/** Installed and enabled provider plugin entry. */
export const ProviderPluginCapabilitySchema = lazySchema(() =>
  z.object({
    kind: z.literal("plugin"),
    identity: providerPluginIdentitySchema(),
    name: CatalogNameSchema,
    description: CatalogDescriptionSchema,
    mentionPath: z.string().startsWith("plugin://").max(PROVIDER_CATALOG_PATH_MAX_CHARS),
    marketplaceName: CatalogMarketplaceNameSchema,
    version: CatalogVersionSchema.optional(),
    developerName: CatalogNameSchema.optional(),
    capabilities: z.array(CatalogCapabilitySchema).max(100),
  }).strict(),
);
/** Installed and enabled provider plugin entry. */
export type ProviderPluginCapability = z.infer<ReturnType<typeof ProviderPluginCapabilitySchema>>;

/** Deprecated Codex custom prompt entry available through the slash gesture. */
export const ProviderCustomPromptCapabilitySchema = lazySchema(() =>
  z.object({
    kind: z.literal("customPrompt"),
    identity: providerCustomPromptIdentitySchema(),
    name: CatalogNameSchema,
    description: CatalogDescriptionSchema,
    nativeName: CatalogNameSchema.optional(),
    path: CatalogPathSchema.optional(),
  }).strict(),
);

/** Provider-defined command entry available through the slash gesture. */
export const ProviderCommandCapabilitySchema = lazySchema(() =>
  z.object({
    kind: z.literal("providerCommand"),
    identity: providerCommandIdentitySchema(),
    name: CatalogNameSchema,
    description: CatalogDescriptionSchema,
    nativeName: CatalogNameSchema.optional(),
    path: CatalogPathSchema.optional(),
  }).strict(),
);

/** Discriminated provider capability entry with a collision-safe native identity. */
export const ProviderCapabilityEntrySchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    ProviderSkillCapabilitySchema(),
    ProviderPluginCapabilitySchema(),
    ProviderCustomPromptCapabilitySchema(),
    ProviderCommandCapabilitySchema(),
  ]),
);
/** Discriminated provider capability entry with a collision-safe native identity. */
export type ProviderCapabilityEntry = z.infer<ReturnType<typeof ProviderCapabilityEntrySchema>>;

/** Selectable provider agent kept separate from invocable catalog entries. */
export const SelectableProviderAgentSchema = lazySchema(() =>
  z.object({
    providerId: ProviderIdSchema,
    nativeId: CatalogNativeIdSchema,
    name: CatalogAgentNameSchema,
    path: CatalogPathSchema,
    description: CatalogDescriptionSchema.optional(),
  }).strict(),
);
/** Selectable provider agent kept separate from invocable catalog entries. */
export type SelectableProviderAgent = z.infer<ReturnType<typeof SelectableProviderAgentSchema>>;

/** Discovery context represented by a provider catalog snapshot. */
export const ProviderCatalogContextSchema = lazySchema(() =>
  z.discriminatedUnion("scope", [
    z.object({ scope: z.literal("user") }).strict(),
    z.object({
      scope: z.literal("workspace"),
      workspaceId: z.string().trim().min(1).max(128),
      threadId: z.string().trim().min(1).max(128).optional(),
    }).strict(),
    z.object({ scope: z.literal("path"), cwd: CatalogPathSchema }).strict(),
  ]),
);
/** Discovery context represented by a provider catalog snapshot. */
export type ProviderCatalogContext = z.infer<ReturnType<typeof ProviderCatalogContextSchema>>;

/** Catalog source that accepted or rejected provider capability metadata. */
export const ProviderCatalogDiagnosticSourceKindSchema = z.enum([
  "providerCatalog",
  "appServerSkills",
  "appServerPlugins",
  "appServerConfig",
  "customPromptAdapter",
  "standaloneAgentAdapter",
]);
/** Catalog source that accepted or rejected provider capability metadata. */
export type ProviderCatalogDiagnosticSourceKind = z.infer<
  typeof ProviderCatalogDiagnosticSourceKindSchema
>;

/** Unscoped source diagnostic produced before a catalog request context is known. */
export const ProviderCatalogSourceDiagnosticSchema = lazySchema(() =>
  z.object({
    sourceKind: ProviderCatalogDiagnosticSourceKindSchema,
    rejectedSource: z.string().trim().min(1).max(256),
    severity: z.enum(["info", "warning", "error"]),
    code: z.enum(["source-unavailable", "discovery-error", "partial-result"]),
    message: z.string().min(1).max(1_000),
  }).strict(),
);
/** Unscoped source diagnostic produced before a catalog request context is known. */
export type ProviderCatalogSourceDiagnostic = z.infer<
  ReturnType<typeof ProviderCatalogSourceDiagnosticSchema>
>;

/** Provider and request-scoped catalog diagnostic safe for display or logging. */
export const ProviderCatalogDiagnosticSchema = lazySchema(() =>
  ProviderCatalogSourceDiagnosticSchema().extend({
    providerId: ProviderIdSchema,
    context: ProviderCatalogContextSchema(),
  }).strict(),
);
/** Provider and request-scoped catalog diagnostic safe for display or logging. */
export type ProviderCatalogDiagnostic = z.infer<ReturnType<typeof ProviderCatalogDiagnosticSchema>>;

/** Freshness metadata for a provider catalog snapshot. */
export const ProviderCatalogFreshnessSchema = lazySchema(() =>
  z.discriminatedUnion("status", [
    z.object({ status: z.literal("fresh"), fetchedAt: z.string().datetime() }).strict(),
    z.object({
      status: z.literal("stale"),
      fetchedAt: z.string().datetime(),
      reason: z.string().min(1).max(500),
    }).strict(),
  ]),
);
/** Freshness metadata for a provider catalog snapshot. */
export type ProviderCatalogFreshness = z.infer<ReturnType<typeof ProviderCatalogFreshnessSchema>>;

/** Validated request for a provider catalog snapshot. */
export const ProviderCatalogRequestSchema = lazySchema(() =>
  z.object({
    providerId: ProviderIdSchema,
    workspaceId: z.string().trim().min(1).max(128).optional(),
    threadId: z.string().trim().min(1).max(128).optional(),
    cwd: CatalogPathSchema.optional(),
  }).strict().superRefine((value, context) => {
    if (value.threadId && !value.workspaceId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["threadId"],
        message: "threadId requires workspaceId",
      });
    }
    if (value.workspaceId && value.cwd) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cwd"],
        message: "cwd cannot be combined with workspaceId",
      });
    }
  }),
);
/** Validated request for a provider catalog snapshot. */
export type ProviderCatalogRequest = z.infer<ReturnType<typeof ProviderCatalogRequestSchema>>;

function contextForCatalogRequest(
  request: z.infer<ReturnType<typeof ProviderCatalogRequestSchema>>,
): z.infer<ReturnType<typeof ProviderCatalogContextSchema>> {
  if (request.cwd) return { scope: "path", cwd: request.cwd };
  if (request.workspaceId) {
    return {
      scope: "workspace",
      workspaceId: request.workspaceId,
      ...(request.threadId ? { threadId: request.threadId } : {}),
    };
  }
  return { scope: "user" };
}

function equalCatalogContext(
  left: ProviderCatalogContext,
  right: ProviderCatalogContext,
): boolean {
  if (left.scope !== right.scope) return false;

  switch (left.scope) {
    case "user":
      return right.scope === "user";
    case "workspace":
      return right.scope === "workspace"
        && left.workspaceId === right.workspaceId
        && left.threadId === right.threadId;
    case "path":
      return right.scope === "path" && left.cwd === right.cwd;
    default: {
      const exhaustiveContext: never = left;
      return exhaustiveContext;
    }
  }
}

/** Provider capability catalog snapshot for one validated discovery context. */
export const ProviderCatalogSnapshotSchema = lazySchema(() =>
  z.object({
    providerId: ProviderIdSchema,
    context: ProviderCatalogContextSchema(),
    freshness: ProviderCatalogFreshnessSchema(),
    diagnostics: z.array(ProviderCatalogDiagnosticSchema()).max(PROVIDER_CATALOG_MAX_DIAGNOSTICS),
    entries: z.array(ProviderCapabilityEntrySchema()).max(PROVIDER_CATALOG_MAX_ENTRIES),
    selectableAgents: z.array(SelectableProviderAgentSchema())
      .max(PROVIDER_CATALOG_MAX_SELECTABLE_AGENTS),
  }).strict().superRefine((value, context) => {
    value.entries.forEach((entry, index) => {
      if (entry.identity.providerId !== value.providerId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["entries", index, "identity", "providerId"],
          message: "Entry identity providerId must match the snapshot providerId",
        });
      }
    });
    value.selectableAgents.forEach((agent, index) => {
      if (agent.providerId !== value.providerId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["selectableAgents", index, "providerId"],
          message: "Selectable agent providerId must match the snapshot providerId",
        });
      }
    });
    value.diagnostics.forEach((diagnostic, index) => {
      if (diagnostic.providerId !== value.providerId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["diagnostics", index, "providerId"],
          message: "Diagnostic providerId must match the snapshot providerId",
        });
      }
      if (!equalCatalogContext(diagnostic.context, value.context)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["diagnostics", index, "context"],
          message: "Diagnostic context must match the snapshot context",
        });
      }
    });
  }),
);
/** Provider capability catalog snapshot for one validated discovery context. */
export type ProviderCatalogSnapshot = z.infer<ReturnType<typeof ProviderCatalogSnapshotSchema>>;

/** Stable provider capability identity used by incremental removals. */
export const ProviderCapabilityIdentitySchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    providerSkillIdentitySchema(),
    providerPluginIdentitySchema(),
    providerCustomPromptIdentitySchema(),
    providerCommandIdentitySchema(),
  ]),
);
/** Stable provider capability identity used by incremental removals. */
export type ProviderCapabilityIdentity = z.infer<ReturnType<typeof ProviderCapabilityIdentitySchema>>;

/** Incremental selectable-agent reconciliation payload. */
export const SelectableProviderAgentChangesSchema = lazySchema(() =>
  z.object({
    additions: z.array(SelectableProviderAgentSchema()).max(PROVIDER_CATALOG_MAX_SELECTABLE_AGENTS),
    updates: z.array(SelectableProviderAgentSchema()).max(PROVIDER_CATALOG_MAX_SELECTABLE_AGENTS),
    removals: z.array(z.string().trim().min(1).max(512)).max(PROVIDER_CATALOG_MAX_SELECTABLE_AGENTS),
  }).strict(),
);
/** Incremental selectable-agent reconciliation payload. */
export type SelectableProviderAgentChanges = z.infer<ReturnType<typeof SelectableProviderAgentChangesSchema>>;

/** Incremental provider catalog reconciliation emitted after a background refresh. */
export const ProviderCatalogChangeSchema = lazySchema(() =>
  z.object({
    request: ProviderCatalogRequestSchema(),
    additions: z.array(ProviderCapabilityEntrySchema()).max(PROVIDER_CATALOG_MAX_ENTRIES),
    updates: z.array(ProviderCapabilityEntrySchema()).max(PROVIDER_CATALOG_MAX_ENTRIES),
    removals: z.array(ProviderCapabilityIdentitySchema()).max(PROVIDER_CATALOG_MAX_ENTRIES),
    selectableAgents: SelectableProviderAgentChangesSchema(),
    diagnostics: z.array(ProviderCatalogDiagnosticSchema())
      .max(PROVIDER_CATALOG_MAX_DIAGNOSTICS)
      .optional(),
    freshness: ProviderCatalogFreshnessSchema().optional(),
  }).strict().superRefine((value, context) => {
    const expectedContext = contextForCatalogRequest(value.request);
    value.diagnostics?.forEach((diagnostic, index) => {
      if (diagnostic.providerId !== value.request.providerId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["diagnostics", index, "providerId"],
          message: "Diagnostic providerId must match the change request providerId",
        });
      }
      if (!equalCatalogContext(diagnostic.context, expectedContext)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["diagnostics", index, "context"],
          message: "Diagnostic context must match the change request context",
        });
      }
    });
  }),
);
/** Incremental provider catalog reconciliation emitted after a background refresh. */
export type ProviderCatalogChange = z.infer<ReturnType<typeof ProviderCatalogChangeSchema>>;
