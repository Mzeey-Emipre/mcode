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
const CatalogDescriptionSchema = z.string().max(2_000);
const CatalogNativeIdSchema = z.string().trim().min(1).max(512);
const CatalogPathSchema = z.string().min(1).max(PROVIDER_CATALOG_PATH_MAX_CHARS);

function identitySchema<TKind extends ProviderCapabilityKind>(kind: TKind) {
  return z.object({
    providerId: ProviderIdSchema,
    kind: z.literal(kind),
    nativeId: CatalogNativeIdSchema,
  }).strict();
}

/** Provider Skill entry available for explicit invocation. */
export const ProviderSkillCapabilitySchema = lazySchema(() =>
  z.object({
    kind: z.literal("skill"),
    identity: identitySchema("skill"),
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
    identity: identitySchema("plugin"),
    name: CatalogNameSchema,
    description: CatalogDescriptionSchema,
  }).strict(),
);

/** Deprecated Codex custom prompt entry available through the slash gesture. */
export const ProviderCustomPromptCapabilitySchema = lazySchema(() =>
  z.object({
    kind: z.literal("customPrompt"),
    identity: identitySchema("customPrompt"),
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
    identity: identitySchema("providerCommand"),
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

/** Provider agent metadata returned by the legacy mention endpoint. */
export const ProviderAgentMentionSchema = lazySchema(() =>
  z.object({
    name: CatalogNameSchema,
    path: CatalogPathSchema,
    description: CatalogDescriptionSchema.optional(),
  }).strict(),
);
/** Provider agent metadata returned by the legacy mention endpoint. */
export type ProviderAgentMention = z.infer<ReturnType<typeof ProviderAgentMentionSchema>>;

/** Selectable provider agent kept separate from invocable catalog entries. */
export const SelectableProviderAgentSchema = lazySchema(() =>
  ProviderAgentMentionSchema().extend({
    providerId: ProviderIdSchema,
    nativeId: CatalogNativeIdSchema,
  }).strict(),
);
/** Selectable provider agent kept separate from invocable catalog entries. */
export type SelectableProviderAgent = z.infer<ReturnType<typeof SelectableProviderAgentSchema>>;

/** Typed catalog source diagnostic safe for display or logging. */
export const ProviderCatalogDiagnosticSchema = lazySchema(() =>
  z.object({
    severity: z.enum(["info", "warning", "error"]),
    code: z.enum(["source-unavailable", "discovery-error", "partial-result"]),
    message: z.string().min(1).max(1_000),
  }).strict(),
);
/** Typed catalog source diagnostic safe for display or logging. */
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

/** Provider capability catalog snapshot for one validated discovery context. */
export const ProviderCatalogSnapshotSchema = lazySchema(() =>
  z.object({
    providerId: ProviderIdSchema,
    context: ProviderCatalogContextSchema(),
    freshness: ProviderCatalogFreshnessSchema(),
    diagnostics: z.array(ProviderCatalogDiagnosticSchema()).max(100),
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
  }),
);
/** Provider capability catalog snapshot for one validated discovery context. */
export type ProviderCatalogSnapshot = z.infer<ReturnType<typeof ProviderCatalogSnapshotSchema>>;

/** Stable provider capability identity used by incremental removals. */
export const ProviderCapabilityIdentitySchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    identitySchema("skill"),
    identitySchema("plugin"),
    identitySchema("customPrompt"),
    identitySchema("providerCommand"),
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
    diagnostics: z.array(ProviderCatalogDiagnosticSchema()).max(100).optional(),
    freshness: ProviderCatalogFreshnessSchema().optional(),
  }).strict(),
);
/** Incremental provider catalog reconciliation emitted after a background refresh. */
export type ProviderCatalogChange = z.infer<ReturnType<typeof ProviderCatalogChangeSchema>>;
