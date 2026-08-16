import {
  PROVIDER_CATALOG_MAX_ENTRIES,
  PROVIDER_CATALOG_MAX_DIAGNOSTICS,
  PROVIDER_CATALOG_MAX_SELECTABLE_AGENTS,
  ProviderCapabilityEntrySchema,
  ProviderCatalogSnapshotSchema,
  SelectableProviderAgentSchema,
  SkillInfoSchema,
  type ProviderCapabilityEntry,
  type ProviderCatalogContext,
  type ProviderCatalogDiagnostic,
  type ProviderCatalogSourceDiagnostic,
  type ProviderCatalogFreshness,
  type ProviderCatalogSnapshot,
  type SelectableProviderAgent,
  type SettingsProviderId,
  type SkillInfo,
} from "@mcode/contracts";
import { isCodexProviderCatalogPrompt } from "@mcode/providers";

/** Inputs used to construct and validate one provider catalog snapshot. */
export interface BuildProviderCatalogSnapshotInput {
  readonly providerId: SettingsProviderId;
  readonly context: ProviderCatalogContext;
  readonly skills: readonly SkillInfo[];
  readonly entries?: readonly ProviderCapabilityEntry[];
  readonly agents?: readonly SelectableProviderAgent[];
  readonly diagnostics?: readonly ProviderCatalogSourceDiagnostic[];
  readonly freshness?: ProviderCatalogFreshness;
  readonly fetchedAt?: string;
}

const INVALID_CATALOG_ITEM_DIAGNOSTIC =
  "Some provider catalog items were omitted because their metadata was invalid.";

function providerCommandCapabilityKind(
  providerId: SettingsProviderId,
  item: SkillInfo,
): "customPrompt" | "providerCommand" {
  return providerId === "codex" && isCodexProviderCatalogPrompt(item)
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

function partialResultDiagnostic(
  rejectedSource: string,
  message: string,
): ProviderCatalogSourceDiagnostic {
  return {
    sourceKind: "providerCatalog",
    rejectedSource,
    severity: "warning",
    code: "partial-result",
    message,
  };
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

function parseSelectableAgent(providerId: SettingsProviderId, item: unknown) {
  const agent = SelectableProviderAgentSchema().safeParse(item);
  return agent.success && agent.data.providerId === providerId ? agent.data : undefined;
}

/** Caps and schema-validates a provider catalog snapshot before transport. */
export function buildProviderCatalogSnapshot(
  input: BuildProviderCatalogSnapshotInput,
): ProviderCatalogSnapshot {
  const sourceDiagnostics: ProviderCatalogSourceDiagnostic[] = [
    ...(input.diagnostics ?? []).slice(0, PROVIDER_CATALOG_MAX_DIAGNOSTICS),
  ];
  let diagnosticsCapped = (input.diagnostics?.length ?? 0) > PROVIDER_CATALOG_MAX_DIAGNOSTICS;
  const addDiagnostic = (diagnostic: ProviderCatalogSourceDiagnostic): void => {
    if (sourceDiagnostics.length < PROVIDER_CATALOG_MAX_DIAGNOSTICS) {
      sourceDiagnostics.push(diagnostic);
    }
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
      "entries",
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
      "selectableAgents",
      `Selectable agents were capped at ${PROVIDER_CATALOG_MAX_SELECTABLE_AGENTS}.`,
    ));
  }
  if (invalidItemOmitted) {
    addDiagnostic(partialResultDiagnostic("metadata", INVALID_CATALOG_ITEM_DIAGNOSTIC));
  }
  if (diagnosticsCapped) {
    sourceDiagnostics[PROVIDER_CATALOG_MAX_DIAGNOSTICS - 1] = partialResultDiagnostic(
      "diagnostics",
      `Catalog diagnostics were capped at ${PROVIDER_CATALOG_MAX_DIAGNOSTICS}.`,
    );
  }
  const diagnostics: ProviderCatalogDiagnostic[] = sourceDiagnostics.map((diagnostic) => ({
    ...diagnostic,
    providerId: input.providerId,
    context: input.context,
  }));

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
