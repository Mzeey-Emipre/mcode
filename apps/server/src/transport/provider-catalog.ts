import {
  PROVIDER_CATALOG_MAX_ENTRIES,
  PROVIDER_CATALOG_MAX_DIAGNOSTICS,
  PROVIDER_CATALOG_MAX_SELECTABLE_AGENTS,
  ProviderAgentMentionSchema,
  ProviderCapabilityEntrySchema,
  ProviderCatalogSnapshotSchema,
  SelectableProviderAgentSchema,
  SkillInfoSchema,
  type ProviderAgentMention,
  type ProviderCapabilityEntry,
  type ProviderCatalogContext,
  type ProviderCatalogDiagnostic,
  type ProviderCatalogFreshness,
  type ProviderCatalogSnapshot,
  type SettingsProviderId,
  type SkillInfo,
} from "@mcode/contracts";
import { isCodexCustomPromptCatalogItem } from "../providers/codex/codex-prompt.js";

/** Inputs used to construct and validate one provider catalog snapshot. */
export interface BuildProviderCatalogSnapshotInput {
  readonly providerId: SettingsProviderId;
  readonly context: ProviderCatalogContext;
  readonly skills: readonly SkillInfo[];
  readonly entries?: readonly ProviderCapabilityEntry[];
  readonly agents?: readonly ProviderAgentMention[];
  readonly diagnostics?: readonly ProviderCatalogDiagnostic[];
  readonly freshness?: ProviderCatalogFreshness;
  readonly fetchedAt?: string;
}

const INVALID_CATALOG_ITEM_DIAGNOSTIC =
  "Some provider catalog items were omitted because their metadata was invalid.";

function providerCommandCapabilityKind(
  providerId: SettingsProviderId,
  item: SkillInfo,
): "customPrompt" | "providerCommand" {
  return providerId === "codex" && isCodexCustomPromptCatalogItem(item)
    ? "customPrompt"
    : "providerCommand";
}

function toProviderCapabilityEntry(
  providerId: SettingsProviderId,
  item: SkillInfo,
): ProviderCapabilityEntry {
  const optionalFields = {
    ...(item.nativeName ? { nativeName: item.nativeName } : {}),
    ...(item.path ? { path: item.path } : {}),
  };
  if (item.kind === "skill") {
    return {
      kind: "skill",
      identity: { providerId, kind: "skill", nativeId: item.path ?? item.nativeName ?? item.name },
      name: item.name,
      description: item.description,
      source: item.source,
      ...optionalFields,
    };
  }
  const kind = providerCommandCapabilityKind(providerId, item);
  if (kind === "customPrompt") {
    return {
      kind,
      identity: { providerId, kind, nativeId: item.nativeName ?? item.name },
      name: item.name,
      description: item.description,
      ...optionalFields,
    };
  }
  return {
    kind,
    identity: { providerId, kind, nativeId: item.nativeName ?? item.name },
    name: item.name,
    description: item.description,
    ...optionalFields,
  };
}

function partialResultDiagnostic(message: string): ProviderCatalogDiagnostic {
  return { severity: "warning", code: "partial-result", message };
}

function parseProviderCapabilityEntry(
  providerId: SettingsProviderId,
  item: unknown,
): ProviderCapabilityEntry | undefined {
  const skill = SkillInfoSchema().safeParse(item);
  if (!skill.success) return undefined;
  const entry = ProviderCapabilityEntrySchema().safeParse(
    toProviderCapabilityEntry(providerId, skill.data),
  );
  return entry.success ? entry.data : undefined;
}

function parseSelectableAgent(
  providerId: SettingsProviderId,
  item: unknown,
) {
  const agent = ProviderAgentMentionSchema().safeParse(item);
  if (!agent.success) return undefined;
  const selectableAgent = SelectableProviderAgentSchema().safeParse({
    ...agent.data,
    providerId,
    nativeId: agent.data.name,
  });
  return selectableAgent.success ? selectableAgent.data : undefined;
}

/** Caps and schema-validates a provider catalog snapshot before transport. */
export function buildProviderCatalogSnapshot(
  input: BuildProviderCatalogSnapshotInput,
): ProviderCatalogSnapshot {
  const diagnostics: ProviderCatalogDiagnostic[] = [
    ...(input.diagnostics ?? []).slice(0, PROVIDER_CATALOG_MAX_DIAGNOSTICS),
  ];
  let diagnosticsCapped = (input.diagnostics?.length ?? 0) > PROVIDER_CATALOG_MAX_DIAGNOSTICS;
  const addDiagnostic = (diagnostic: ProviderCatalogDiagnostic): void => {
    if (diagnostics.length < PROVIDER_CATALOG_MAX_DIAGNOSTICS) diagnostics.push(diagnostic);
    else diagnosticsCapped = true;
  };
  let invalidItemOmitted = false;
  const entries: ProviderCapabilityEntry[] = [];
  for (const item of input.skills) {
    if (entries.length >= PROVIDER_CATALOG_MAX_ENTRIES) break;
    const entry = parseProviderCapabilityEntry(input.providerId, item);
    if (entry) entries.push(entry);
    else invalidItemOmitted = true;
  }
  for (const item of input.entries ?? []) {
    if (entries.length >= PROVIDER_CATALOG_MAX_ENTRIES) break;
    const entry = ProviderCapabilityEntrySchema().safeParse(item);
    if (entry.success && entry.data.identity.providerId === input.providerId) {
      entries.push(entry.data);
    } else {
      invalidItemOmitted = true;
    }
  }
  if (input.skills.length + (input.entries?.length ?? 0) > PROVIDER_CATALOG_MAX_ENTRIES) {
    addDiagnostic(partialResultDiagnostic(
      `Catalog entries were capped at ${PROVIDER_CATALOG_MAX_ENTRIES}.`,
    ));
  }

  const discoveredAgents = input.agents ?? [];
  const selectableAgents = [];
  for (const item of discoveredAgents.slice(0, PROVIDER_CATALOG_MAX_SELECTABLE_AGENTS)) {
    const agent = parseSelectableAgent(input.providerId, item);
    if (agent) selectableAgents.push(agent);
    else invalidItemOmitted = true;
  }
  if (discoveredAgents.length > PROVIDER_CATALOG_MAX_SELECTABLE_AGENTS) {
    addDiagnostic(partialResultDiagnostic(
      `Selectable agents were capped at ${PROVIDER_CATALOG_MAX_SELECTABLE_AGENTS}.`,
    ));
  }
  if (invalidItemOmitted) {
    addDiagnostic(partialResultDiagnostic(INVALID_CATALOG_ITEM_DIAGNOSTIC));
  }
  if (diagnosticsCapped) {
    diagnostics[PROVIDER_CATALOG_MAX_DIAGNOSTICS - 1] = partialResultDiagnostic(
      `Catalog diagnostics were capped at ${PROVIDER_CATALOG_MAX_DIAGNOSTICS}.`,
    );
  }

  return ProviderCatalogSnapshotSchema().parse({
    providerId: input.providerId,
    context: input.context,
    freshness: input.freshness ?? {
      status: "fresh",
      fetchedAt: input.fetchedAt ?? new Date().toISOString(),
    },
    diagnostics,
    entries,
    selectableAgents,
  });
}
