import { open, opendir } from "fs/promises";
import { join } from "path";
import {
  PROVIDER_CATALOG_MAX_CODEX_AGENT_FILE_BYTES,
  PROVIDER_CATALOG_MAX_CODEX_AGENT_FILES,
  PROVIDER_CATALOG_MAX_ENTRIES,
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

/** Limits used while reading Codex agent files for a catalog snapshot. */
export interface CodexAgentDiscoveryLimits {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
}

/** Limit state collected while reading Codex agent files. */
export interface CodexAgentDiscoveryLimitState {
  readonly fileCount: boolean;
  readonly fileSize: boolean;
}

/** Bounded Codex agent discovery result used to build a catalog snapshot. */
export interface BoundedCodexAgentDiscovery {
  readonly agents: readonly ProviderAgentMention[];
  readonly limits: CodexAgentDiscoveryLimitState;
}

/** Inputs used to construct and validate one provider catalog snapshot. */
export interface BuildProviderCatalogSnapshotInput {
  readonly providerId: SettingsProviderId;
  readonly context: ProviderCatalogContext;
  readonly skills: readonly SkillInfo[];
  readonly agentDiscovery?: BoundedCodexAgentDiscovery;
  readonly diagnostics?: readonly ProviderCatalogDiagnostic[];
  readonly freshness?: ProviderCatalogFreshness;
  readonly fetchedAt?: string;
}

const DEFAULT_CODEX_AGENT_DISCOVERY_LIMITS: CodexAgentDiscoveryLimits = {
  maxFiles: PROVIDER_CATALOG_MAX_CODEX_AGENT_FILES,
  maxFileBytes: PROVIDER_CATALOG_MAX_CODEX_AGENT_FILE_BYTES,
};
const INVALID_CATALOG_ITEM_DIAGNOSTIC =
  "Some provider catalog items were omitted because their metadata was invalid.";

function tomlStringValue(body: string, key: string): string | undefined {
  const match = new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m").exec(body);
  return match?.[1]?.trim() || undefined;
}

async function readBoundedAgentFile(
  path: string,
  maxFileBytes: number,
): Promise<{ body?: string; capped: boolean }> {
  let file;
  try {
    file = await open(path, "r");
    const buffer = Buffer.allocUnsafe(maxFileBytes + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxFileBytes) return { capped: true };
    return { body: buffer.subarray(0, bytesRead).toString("utf8"), capped: false };
  } catch {
    return { capped: false };
  } finally {
    await file?.close().catch(() => undefined);
  }
}

/** Discovers Codex agents without exceeding the supplied file-count or per-file read limits. */
export async function discoverBoundedCodexAgents(
  directories: readonly string[],
  limits: CodexAgentDiscoveryLimits = DEFAULT_CODEX_AGENT_DISCOVERY_LIMITS,
): Promise<BoundedCodexAgentDiscovery> {
  const byName = new Map<string, ProviderAgentMention>();
  let inspectedFiles = 0;
  let fileCountCapped = false;
  let fileSizeCapped = false;

  for (const directory of directories) {
    let handle;
    try {
      handle = await opendir(directory);
    } catch {
      continue;
    }

    for await (const entry of handle) {
      if (!entry.isFile() || !entry.name.endsWith(".toml")) continue;
      if (inspectedFiles >= limits.maxFiles) {
        fileCountCapped = true;
        break;
      }
      inspectedFiles += 1;

      const path = join(directory, entry.name);
      const result = await readBoundedAgentFile(path, limits.maxFileBytes);
      if (result.capped) {
        fileSizeCapped = true;
        continue;
      }
      if (result.body === undefined) continue;

      const fallbackName = entry.name.slice(0, -".toml".length);
      const name = tomlStringValue(result.body, "name") ?? fallbackName;
      const description = tomlStringValue(result.body, "description");
      byName.set(name, { name, path, ...(description ? { description } : {}) });
    }

    if (fileCountCapped) break;
  }

  return {
    agents: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    limits: { fileCount: fileCountCapped, fileSize: fileSizeCapped },
  };
}

function providerCommandCapabilityKind(
  providerId: SettingsProviderId,
  item: SkillInfo,
): "customPrompt" | "providerCommand" {
  return providerId === "codex" && item.name.startsWith("prompts:")
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
  const diagnostics: ProviderCatalogDiagnostic[] = [...(input.diagnostics ?? [])];
  let invalidItemOmitted = false;
  const entries: ProviderCapabilityEntry[] = [];
  for (const item of input.skills.slice(0, PROVIDER_CATALOG_MAX_ENTRIES)) {
    const entry = parseProviderCapabilityEntry(input.providerId, item);
    if (entry) entries.push(entry);
    else invalidItemOmitted = true;
  }
  if (input.skills.length > PROVIDER_CATALOG_MAX_ENTRIES) {
    diagnostics.push(partialResultDiagnostic(
      `Catalog entries were capped at ${PROVIDER_CATALOG_MAX_ENTRIES}.`,
    ));
  }

  const discoveredAgents = input.agentDiscovery?.agents ?? [];
  const selectableAgents = [];
  for (const item of discoveredAgents.slice(0, PROVIDER_CATALOG_MAX_SELECTABLE_AGENTS)) {
    const agent = parseSelectableAgent(input.providerId, item);
    if (agent) selectableAgents.push(agent);
    else invalidItemOmitted = true;
  }
  if (discoveredAgents.length > PROVIDER_CATALOG_MAX_SELECTABLE_AGENTS) {
    diagnostics.push(partialResultDiagnostic(
      `Selectable agents were capped at ${PROVIDER_CATALOG_MAX_SELECTABLE_AGENTS}.`,
    ));
  }
  if (input.agentDiscovery?.limits.fileCount) {
    diagnostics.push(partialResultDiagnostic(
      `Codex agent discovery inspected at most ${PROVIDER_CATALOG_MAX_CODEX_AGENT_FILES} files.`,
    ));
  }
  if (input.agentDiscovery?.limits.fileSize) {
    diagnostics.push(partialResultDiagnostic(
      `Codex agent files larger than ${PROVIDER_CATALOG_MAX_CODEX_AGENT_FILE_BYTES} bytes were omitted.`,
    ));
  }
  if (invalidItemOmitted) {
    diagnostics.push(partialResultDiagnostic(INVALID_CATALOG_ITEM_DIAGNOSTIC));
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
