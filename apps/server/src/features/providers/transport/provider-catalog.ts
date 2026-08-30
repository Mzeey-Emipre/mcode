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

interface CatalogItemCollection<T> {
  items: T[];
  invalidItemOmitted: boolean;
}

function collectEntries(input: BuildProviderCatalogSnapshotInput): CatalogItemCollection<ProviderCapabilityEntry> {
  const items: ProviderCapabilityEntry[] = [];
  let invalidItemOmitted = false;
  for (const skill of input.skills) {
    if (items.length >= PROVIDER_CATALOG_MAX_ENTRIES) break;
    const entry = parseProviderCapabilityEntry(input.providerId, skill);
    if (entry) items.push(entry);
    else invalidItemOmitted = true;
  }
  for (const suppliedEntry of input.entries ?? []) {
    if (items.length >= PROVIDER_CATALOG_MAX_ENTRIES) break;
    const entry = ProviderCapabilityEntrySchema().safeParse(suppliedEntry);
    if (entry.success && entry.data.identity.providerId === input.providerId) items.push(entry.data);
    else invalidItemOmitted = true;
  }
  return { items, invalidItemOmitted };
}

function collectSelectableAgents(input: BuildProviderCatalogSnapshotInput): CatalogItemCollection<SelectableProviderAgent> {
  const items: SelectableProviderAgent[] = [];
  let invalidItemOmitted = false;
  for (const suppliedAgent of input.agents ?? []) {
    if (items.length >= PROVIDER_CATALOG_MAX_SELECTABLE_AGENTS) break;
    const agent = parseSelectableAgent(input.providerId, suppliedAgent);
    if (agent) items.push(agent);
    else invalidItemOmitted = true;
  }
  return { items, invalidItemOmitted };
}

function sourceDiagnostics(input: BuildProviderCatalogSnapshotInput): {
  diagnostics: ProviderCatalogSourceDiagnostic[];
  add: (diagnostic: ProviderCatalogSourceDiagnostic) => void;
  hasBeenCapped: () => boolean;
} {
  const diagnostics = (input.diagnostics ?? []).slice(0, PROVIDER_CATALOG_MAX_DIAGNOSTICS);
  let capped = (input.diagnostics?.length ?? 0) > PROVIDER_CATALOG_MAX_DIAGNOSTICS;
  return {
    diagnostics,
    add(diagnostic) {
      if (diagnostics.length < PROVIDER_CATALOG_MAX_DIAGNOSTICS) diagnostics.push(diagnostic);
      else capped = true;
    },
    hasBeenCapped: () => capped,
  };
}

function withDiagnosticContext(
  input: BuildProviderCatalogSnapshotInput,
  sourceDiagnostics: ProviderCatalogSourceDiagnostic[],
): ProviderCatalogDiagnostic[] {
  return sourceDiagnostics.map((diagnostic) => ({
    ...diagnostic,
    providerId: input.providerId,
    context: input.context,
  }));
}

function addCollectionDiagnostics(
  input: BuildProviderCatalogSnapshotInput,
  diagnostics: ReturnType<typeof sourceDiagnostics>,
  invalidItemOmitted: boolean,
): void {
  if (input.skills.length + (input.entries?.length ?? 0) > PROVIDER_CATALOG_MAX_ENTRIES) {
    diagnostics.add(partialResultDiagnostic("entries", `Catalog entries were capped at ${PROVIDER_CATALOG_MAX_ENTRIES}.`));
  }
  if ((input.agents?.length ?? 0) > PROVIDER_CATALOG_MAX_SELECTABLE_AGENTS) {
    diagnostics.add(partialResultDiagnostic("selectableAgents", `Selectable agents were capped at ${PROVIDER_CATALOG_MAX_SELECTABLE_AGENTS}.`));
  }
  if (invalidItemOmitted) diagnostics.add(partialResultDiagnostic("metadata", INVALID_CATALOG_ITEM_DIAGNOSTIC));
  if (diagnostics.hasBeenCapped()) {
    diagnostics.diagnostics[PROVIDER_CATALOG_MAX_DIAGNOSTICS - 1] = partialResultDiagnostic(
      "diagnostics",
      `Catalog diagnostics were capped at ${PROVIDER_CATALOG_MAX_DIAGNOSTICS}.`,
    );
  }
}

/** Caps and schema-validates a provider catalog snapshot before transport. */
export function buildProviderCatalogSnapshot(
  input: BuildProviderCatalogSnapshotInput,
): ProviderCatalogSnapshot {
  const diagnostics = sourceDiagnostics(input);
  const entries = collectEntries(input);
  const selectableAgents = collectSelectableAgents(input);
  const invalidItemOmitted = entries.invalidItemOmitted || selectableAgents.invalidItemOmitted;
  addCollectionDiagnostics(input, diagnostics, invalidItemOmitted);

  return ProviderCatalogSnapshotSchema().parse({
    providerId: input.providerId,
    context: input.context,
    freshness: input.freshness ?? {
      status: "fresh",
      fetchedAt: input.fetchedAt ?? new Date().toISOString(),
    },
    diagnostics: withDiagnosticContext(input, diagnostics.diagnostics),
    entries: entries.items,
    selectableAgents: selectableAgents.items,
  });
}
