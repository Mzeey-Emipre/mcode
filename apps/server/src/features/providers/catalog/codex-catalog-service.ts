import { basename } from "path";
import { inject, injectable } from "tsyringe";
import type {
  ProviderCatalogDiagnosticSourceKind,
  ProviderCatalogSourceDiagnostic,
  ProviderCatalogFreshness,
  ProviderPluginCapability,
  SelectableProviderAgent,
  SkillInfo,
} from "@mcode/contracts";
import {
  PROVIDER_CATALOG_MAX_ENTRIES,
  ProviderPluginCapabilitySchema,
  PROVIDER_CATALOG_MAX_DIAGNOSTICS,
  PROVIDER_CATALOG_MAX_SELECTABLE_AGENTS,
  SelectableProviderAgentSchema,
  SkillInfoSchema,
} from "@mcode/contracts";
import { logger } from "@mcode/shared";
import {
  createCodexCatalogClient,
  discoverCodexCatalogAgents,
  type CodexCatalogAgentDiscovery,
  type CodexCatalogClient as ProviderCodexCatalogClient,
  type CodexCatalogClientOptions,
  type CodexCatalogPluginReadParams,
  type CodexCatalogPluginReadResult,
  type CodexCatalogPluginsResult,
} from "@mcode/providers";
import { codexPluginNameFromSkillPath } from "../../agents/skills/catalog/skill-service.js";
import { SettingsService } from "../../settings/settings-service.js";
import { EnvService } from "../../../runtime/environment/env-service.js";
import {
  CodexCustomPromptService,
  type CodexCustomPromptDiscoveryResult,
} from "./codex-custom-prompt-service.js";
import type { JobObject } from "../../../runtime/process/containment/job-object.js";

const CODEX_CATALOG_IDLE_TTL_MS = 60_000;
const CODEX_CATALOG_MAX_CONTEXTS = 64;
const CODEX_CATALOG_MAX_CWD_LENGTH = 4_096;
const CODEX_CATALOG_MAX_PLUGIN_DETAIL_READS = 64;
const CODEX_CATALOG_PLUGIN_DETAIL_CONCURRENCY = 8;

interface PluginCandidate {
  readonly marketplaceName: string;
  readonly marketplacePath: string | null;
  readonly summary: Record<string, unknown>;
}

/** Result of refreshing Codex capabilities for one working-directory context. */
export interface CodexCatalogRefreshResult {
  readonly skills: SkillInfo[];
  readonly plugins: ProviderPluginCapability[];
  readonly prompts: SkillInfo[];
  readonly agents: SelectableProviderAgent[];
  readonly diagnostics: ProviderCatalogSourceDiagnostic[];
  readonly freshness: ProviderCatalogFreshness;
  readonly skillsAvailable: boolean;
  readonly promptsAvailable: boolean;
}

/** Minimal app-server surface used by the provider-wide catalog connection. */
export type CodexCatalogClient = ProviderCodexCatalogClient;

/** Creates the external app-server client used by {@link CodexCatalogService}. */
@injectable()
export class CodexCatalogClientFactory {
  /** Creates one catalog-only Codex app-server client. */
  create(options: CodexCatalogClientOptions): CodexCatalogClient {
    return createCodexCatalogClient(options);
  }
}

function catalogKey(cwd?: string): string {
  return cwd ?? "";
}

function skillSource(path: string, scope: string): SkillInfo["source"] {
  if (codexPluginNameFromSkillPath(path)) return "plugin";
  if (scope === "user") return "user";
  if (scope === "repo") return "project";
  return "agent";
}

interface EnabledSkillRecord extends Record<string, unknown> {
  readonly name: string;
  readonly path: string;
}

function enabledSkillRecord(skill: unknown): EnabledSkillRecord | undefined {
  if (!skill || typeof skill !== "object") return undefined;
  const value = skill as Record<string, unknown>;
  if (value.enabled !== true || typeof value.name !== "string" || typeof value.path !== "string") {
    return undefined;
  }
  return { ...value, name: value.name, path: value.path };
}

function skillDescription(value: Record<string, unknown>): string {
  const interfaceValue = value.interface && typeof value.interface === "object"
    ? value.interface as Record<string, unknown>
    : undefined;
  return [interfaceValue?.shortDescription, value.shortDescription, value.description]
    .find((candidate): candidate is string => typeof candidate === "string") ?? "";
}

function mapSkill(skill: unknown): SkillInfo | undefined {
  const value = enabledSkillRecord(skill);
  if (!value) return undefined;
  const scope = typeof value.scope === "string" ? value.scope : "";
  const parsed = SkillInfoSchema().safeParse({
    name: value.name,
    description: skillDescription(value),
    kind: "skill",
    source: skillSource(value.path, scope),
    providers: ["codex"],
    nativeName: value.name,
    path: value.path,
  });
  return parsed.success ? parsed.data : undefined;
}

function safeDiagnosticSource(value: string, fallback: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return (normalized || fallback).slice(0, 256);
}

function sourceDiagnostic(
  sourceKind: ProviderCatalogDiagnosticSourceKind,
  rejectedSource: string,
  code: ProviderCatalogSourceDiagnostic["code"],
  message: string,
): ProviderCatalogSourceDiagnostic {
  return {
    sourceKind,
    rejectedSource: safeDiagnosticSource(rejectedSource, sourceKind),
    severity: "warning",
    code,
    message,
  };
}

function reconcileSkills(rawSkills: unknown): {
  skills: SkillInfo[];
  invalidMetadata: boolean;
  entryLimitReached: boolean;
} {
  if (!Array.isArray(rawSkills)) {
    return { skills: [], invalidMetadata: true, entryLimitReached: false };
  }
  const byPath = new Map<string, SkillInfo>();
  let invalidMetadata = false;
  for (const rawSkill of rawSkills.slice(0, PROVIDER_CATALOG_MAX_ENTRIES)) {
    if (
      rawSkill &&
      typeof rawSkill === "object" &&
      (rawSkill as Record<string, unknown>).enabled === false
    ) {
      continue;
    }
    const skill = mapSkill(rawSkill);
    if (skill?.path) byPath.set(skill.path, skill);
    else invalidMetadata = true;
  }
  return {
    skills: [...byPath.values()],
    invalidMetadata,
    entryLimitReached: rawSkills.length > PROVIDER_CATALOG_MAX_ENTRIES,
  };
}

function upstreamDiagnostics(rawErrors: unknown): ProviderCatalogSourceDiagnostic[] {
  if (!Array.isArray(rawErrors)) return [];
  return rawErrors.slice(0, 90).flatMap((error) => {
    const message = error && typeof error === "object"
      ? (error as Record<string, unknown>).message
      : undefined;
    return typeof message === "string"
      ? [sourceDiagnostic(
          "appServerSkills",
          "skills/list",
          "discovery-error",
          "Codex reported a Skill catalog error.",
        )]
      : [];
  });
}

function pluginDetailDescription(result: CodexCatalogPluginReadResult): string {
  const plugin = result.plugin;
  const summaryInterface = plugin.summary?.interface;
  return [
    plugin.description,
    summaryInterface?.shortDescription,
    summaryInterface?.longDescription,
  ].find((candidate): candidate is string => (
    typeof candidate === "string" && candidate.trim().length > 0
  ))?.trim() ?? "";
}

function pluginSummaryDescription(summary: Record<string, unknown>): string {
  const interfaceValue = summary.interface && typeof summary.interface === "object"
    ? summary.interface as Record<string, unknown>
    : undefined;
  return [interfaceValue?.shortDescription, interfaceValue?.longDescription]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0)
    ?.trim() ?? "";
}

function pluginReadParams(
  marketplaceName: string,
  marketplacePath: string | null,
  pluginName: string,
): CodexCatalogPluginReadParams {
  return marketplacePath
    ? { marketplacePath, pluginName }
    : { remoteMarketplaceName: marketplaceName, pluginName };
}

async function readMissingPluginDescriptions(
  client: CodexCatalogClient,
  candidates: PluginCandidate[],
  diagnostics: ProviderCatalogSourceDiagnostic[],
): Promise<Map<string, string>> {
  const missing = candidates.filter(({ summary }) => (
    typeof summary.id === "string" &&
    typeof summary.name === "string" &&
    !pluginSummaryDescription(summary)
  ));
  const selected = missing.slice(0, CODEX_CATALOG_MAX_PLUGIN_DETAIL_READS);
  const descriptions = new Map<string, string>();
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < selected.length) {
      const candidate = selected[nextIndex++];
      if (!candidate) return;
      const { marketplaceName, marketplacePath, summary } = candidate;
      const pluginId = summary.id as string;
      try {
        const detail = await client.readPlugin(pluginReadParams(
          marketplaceName,
          marketplacePath,
          summary.name as string,
        ));
        descriptions.set(pluginId, pluginDetailDescription(detail));
      } catch {
        diagnostics.push(sourceDiagnostic(
          "appServerPlugins",
          "plugin/read",
          "partial-result",
          "Codex plugin details are unavailable for one installed plugin.",
        ));
      }
    }
  };

  await Promise.all(Array.from(
    { length: Math.min(CODEX_CATALOG_PLUGIN_DETAIL_CONCURRENCY, selected.length) },
    worker,
  ));
  if (missing.length > CODEX_CATALOG_MAX_PLUGIN_DETAIL_READS) {
    diagnostics.push(sourceDiagnostic(
      "appServerPlugins",
      "plugin/read",
      "partial-result",
      `Codex plugin detail reads were capped at ${CODEX_CATALOG_MAX_PLUGIN_DETAIL_READS} entries.`,
    ));
  }
  return descriptions;
}

function pluginLoadDiagnostics(result: CodexCatalogPluginsResult): ProviderCatalogSourceDiagnostic[] {
  const errors = Array.isArray(result.marketplaceLoadErrors) ? result.marketplaceLoadErrors : [];
  return errors.slice(0, 90).flatMap((error) => {
    if (!error || typeof error.marketplacePath !== "string" || typeof error.message !== "string") return [];
    return [sourceDiagnostic(
      "appServerPlugins",
      basename(error.marketplacePath),
      "discovery-error",
      "Codex could not load one plugin marketplace source.",
    )];
  });
}

function installedPluginCandidates(result: CodexCatalogPluginsResult): PluginCandidate[] {
  const candidates: PluginCandidate[] = [];
  const marketplaces = Array.isArray(result.marketplaces) ? result.marketplaces : [];
  for (const rawMarketplace of marketplaces) {
    if (!rawMarketplace || typeof rawMarketplace !== "object") continue;
    const marketplace = rawMarketplace as Record<string, unknown>;
    if (typeof marketplace.name !== "string" || !Array.isArray(marketplace.plugins)) continue;
    appendInstalledPlugins(candidates, marketplace);
  }
  return candidates;
}

function appendInstalledPlugins(candidates: PluginCandidate[], marketplace: Record<string, unknown>): void {
  const marketplacePath = typeof marketplace.path === "string" ? marketplace.path : null;
  for (const rawPlugin of marketplace.plugins as unknown[]) {
    if (!rawPlugin || typeof rawPlugin !== "object") continue;
    const summary = rawPlugin as Record<string, unknown>;
    if (summary.installed === true && summary.enabled === true) {
      candidates.push({ marketplaceName: marketplace.name as string, marketplacePath, summary });
    }
  }
}

function pluginInterface(summary: Record<string, unknown>): Record<string, unknown> | undefined {
  return summary.interface && typeof summary.interface === "object"
    ? summary.interface as Record<string, unknown>
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function pluginIdentity(summary: Record<string, unknown>): { id: string; name: string } | undefined {
  return typeof summary.id === "string" && typeof summary.name === "string"
    ? { id: summary.id, name: summary.name }
    : undefined;
}

function pluginPresentation(summary: Record<string, unknown>): {
  name: string;
  version?: string;
  developerName?: string;
  capabilities: string[];
} {
  const interfaceValue = pluginInterface(summary);
  const name = nonEmptyString(interfaceValue?.displayName) ?? summary.name as string;
  const version = [summary.localVersion, summary.version].map(nonEmptyString).find(Boolean);
  const developerName = nonEmptyString(interfaceValue?.developerName);
  const capabilities = Array.isArray(interfaceValue?.capabilities)
    ? interfaceValue.capabilities.filter((value): value is string => typeof value === "string").slice(0, 100)
    : [];
  return { name, ...(version ? { version } : {}), ...(developerName ? { developerName } : {}), capabilities };
}

function pluginCapability(
  candidate: PluginCandidate,
  descriptions: ReadonlyMap<string, string>,
): ProviderPluginCapability | undefined {
  const { marketplaceName, summary } = candidate;
  const identity = pluginIdentity(summary);
  if (!identity) return undefined;
  const presentation = pluginPresentation(summary);
  const parsed = ProviderPluginCapabilitySchema().safeParse({
    kind: "plugin",
    identity: { providerId: "codex", kind: "plugin", nativeId: identity.id },
    description: pluginSummaryDescription(summary) || descriptions.get(identity.id) || "",
    mentionPath: `plugin://${identity.id}`,
    marketplaceName,
    ...presentation,
  });
  return parsed.success ? parsed.data : undefined;
}

function addPluginReconciliationDiagnostics(
  diagnostics: ProviderCatalogSourceDiagnostic[],
  candidateCount: number,
  invalidMetadata: boolean,
): void {
  if (candidateCount > PROVIDER_CATALOG_MAX_ENTRIES) {
    diagnostics.push(sourceDiagnostic("appServerPlugins", "plugin/list", "partial-result", `Codex plugins were capped at ${PROVIDER_CATALOG_MAX_ENTRIES} entries.`));
  }
  if (invalidMetadata) {
    diagnostics.push(sourceDiagnostic("appServerPlugins", "plugin/list", "partial-result", "Some Codex plugins were omitted because their metadata was invalid."));
  }
}

async function reconcilePlugins(
  client: CodexCatalogClient,
  result: CodexCatalogPluginsResult,
): Promise<{
  plugins: ProviderPluginCapability[];
  diagnostics: ProviderCatalogSourceDiagnostic[];
}> {
  const diagnostics = pluginLoadDiagnostics(result);
  const candidates = installedPluginCandidates(result);

  const selectedCandidates = candidates.slice(0, PROVIDER_CATALOG_MAX_ENTRIES);
  const detailDescriptions = await readMissingPluginDescriptions(
    client,
    selectedCandidates,
    diagnostics,
  );
  const pluginsById = new Map<string, ProviderPluginCapability>();
  let invalidMetadata = false;
  for (const candidate of selectedCandidates) {
    const plugin = pluginCapability(candidate, detailDescriptions);
    if (plugin) pluginsById.set(plugin.identity.nativeId, plugin);
    else invalidMetadata = true;
  }
  addPluginReconciliationDiagnostics(diagnostics, candidates.length, invalidMetadata);
  return {
    plugins: [...pluginsById.values()],
    diagnostics: diagnostics.slice(0, 100),
  };
}

function configuredAgentEntries(rawConfig: unknown): Array<[string, unknown]> {
  if (!rawConfig || typeof rawConfig !== "object") return [];
  const agents = (rawConfig as Record<string, unknown>).agents;
  return agents && typeof agents === "object" && !Array.isArray(agents)
    ? Object.entries(agents)
    : [];
}

function isAgentRegistration(value: Record<string, unknown>): boolean {
  return "config_file" in value || "description" in value || "nickname_candidates" in value;
}

function agentPath(name: string, value: Record<string, unknown>): string {
  return typeof value.config_file === "string" && value.config_file.trim()
    ? value.config_file
    : `codex-config://agents/${encodeURIComponent(name)}`;
}

function agentRecord(rawAgent: unknown): Record<string, unknown> | undefined {
  return rawAgent && typeof rawAgent === "object" && !Array.isArray(rawAgent)
    ? rawAgent as Record<string, unknown>
    : undefined;
}

function invalidConfiguredAgentMetadata(value: Record<string, unknown>): boolean {
  return [value.description, value.config_file]
    .some((field) => field !== undefined && typeof field !== "string");
}

function configuredAgentDescription(value: Record<string, unknown>): { description?: string } {
  const description = typeof value.description === "string" ? value.description.trim() : "";
  return description ? { description } : {};
}

function configuredAgent(name: string, rawAgent: unknown): SelectableProviderAgent | "invalid" | undefined {
  const value = agentRecord(rawAgent);
  if (!value) return undefined;
  if (!isAgentRegistration(value)) return undefined;
  if (invalidConfiguredAgentMetadata(value)) return "invalid";
  const parsed = SelectableProviderAgentSchema().safeParse({
    providerId: "codex",
    nativeId: name,
    name,
    path: agentPath(name, value),
    ...configuredAgentDescription(value),
  });
  return parsed.success ? parsed.data : "invalid";
}

function configuredAgents(rawConfig: unknown): {
  agents: SelectableProviderAgent[];
  invalidMetadata: boolean;
  entryLimitReached: boolean;
} {
  const agents: SelectableProviderAgent[] = [];
  let invalidMetadata = false;
  const registrations = configuredAgentEntries(rawConfig);
  for (const [name, rawAgent] of registrations.slice(0, PROVIDER_CATALOG_MAX_SELECTABLE_AGENTS)) {
    const agent = configuredAgent(name, rawAgent);
    if (agent === "invalid") invalidMetadata = true;
    else if (agent) agents.push(agent);
  }
  return {
    agents: agents.sort((left, right) => left.name.localeCompare(right.name)),
    invalidMetadata,
    entryLimitReached: registrations.length > PROVIDER_CATALOG_MAX_SELECTABLE_AGENTS,
  };
}

function mergeAgents(
  standalone: readonly SelectableProviderAgent[],
  configured: readonly SelectableProviderAgent[],
): SelectableProviderAgent[] {
  const byName = new Map(standalone.map((agent) => [agent.name, agent]));
  for (const agent of configured) {
    if (!byName.has(agent.name)) byName.set(agent.name, agent);
  }
  return [...byName.values()];
}

/** Owns one lazy, thread-independent Codex app-server connection for capability catalogs. */
@injectable()
export class CodexCatalogService {
  private client: CodexCatalogClient | null = null;
  private clientEnvironment: Record<string, string> | null = null;
  private startPromise: Promise<CodexCatalogClient> | null = null;
  private readonly snapshots = new Map<string, CodexCatalogRefreshResult>();
  private readonly requestedContexts = new Map<string, string | undefined>();
  private readonly skillsChangedHandlers = new Set<(cwd?: string) => void>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    @inject(SettingsService) private readonly settingsService: SettingsService,
    @inject("JobObject") private readonly jobObject: JobObject,
    @inject(EnvService) private readonly envService: EnvService,
    @inject(CodexCatalogClientFactory) private readonly clientFactory: CodexCatalogClientFactory,
    @inject(CodexCustomPromptService)
    private readonly customPromptService: CodexCustomPromptService,
  ) {}

  /** Refreshes native Skills, plugins, custom prompts, and selectable agents for one context. */
  async refresh(cwd?: string): Promise<CodexCatalogRefreshResult> {
    this.rememberContext(cwd);
    this.armIdleTimer();
    return this.refreshContext(cwd, false);
  }

  /** Subscribes to completed background refreshes triggered by skills/changed. */
  onSkillsChanged(handler: (cwd?: string) => void): () => void {
    this.skillsChangedHandlers.add(handler);
    return () => this.skillsChangedHandlers.delete(handler);
  }

  /** Returns the last complete Skill list without starting or waiting for catalog work. */
  currentSkills(cwd?: string): SkillInfo[] {
    return this.snapshots.get(catalogKey(cwd))?.skills ?? [];
  }

  /** Returns the latest bounded custom prompt list without starting filesystem work. */
  currentPrompts(): SkillInfo[] {
    return this.customPromptService.currentPrompts();
  }

  /** Refreshes only the bounded custom prompt adapter for an imminent invocation. */
  refreshCustomPrompts(): Promise<CodexCustomPromptDiscoveryResult> {
    return this.customPromptService.refresh();
  }

  /** Returns the last complete refresh result without touching the connection idle deadline. */
  currentSnapshot(cwd?: string): CodexCatalogRefreshResult | undefined {
    return this.snapshots.get(catalogKey(cwd));
  }

  /** Stops the catalog process and clears in-flight connection state. */
  async shutdown(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const client = this.client;
    this.client = null;
    this.clientEnvironment = null;
    this.startPromise = null;
    await client?.kill();
  }

  private async refreshContext(
    cwd: string | undefined,
    forceReload: boolean,
  ): Promise<CodexCatalogRefreshResult> {
    const previous = this.snapshots.get(catalogKey(cwd));
    const environment = this.catalogEnvironment();
    const promptRefresh = this.customPromptService.refresh();
    const standalonePromise = this.discoverStandaloneAgents(environment, cwd);
    try {
      return await this.refreshAvailableCatalog(cwd, forceReload, previous, environment, standalonePromise, promptRefresh);
    } catch (error) {
      return this.refreshUnavailableCatalog(cwd, previous, promptRefresh, standalonePromise, error);
    }
  }

  private catalogEnvironment(): Record<string, string> {
    return (this.client?.isAlive || this.startPromise) && this.clientEnvironment
      ? this.clientEnvironment
      : this.envService.getEnv();
  }

  private discoverStandaloneAgents(environment: Record<string, string>, cwd: string | undefined): Promise<CodexCatalogAgentDiscovery> {
    return discoverCodexCatalogAgents({ environment, cwd }).catch(() => ({
      agents: [],
      diagnostics: [sourceDiagnostic("standaloneAgentAdapter", "agents", "source-unavailable", "Standalone Codex agent discovery is temporarily unavailable for this catalog context.")],
    }));
  }

  private async refreshAvailableCatalog(
    cwd: string | undefined,
    forceReload: boolean,
    previous: CodexCatalogRefreshResult | undefined,
    environment: Record<string, string>,
    standalonePromise: Promise<CodexCatalogAgentDiscovery>,
    promptRefresh: Promise<CodexCustomPromptDiscoveryResult>,
  ): Promise<CodexCatalogRefreshResult> {
    const [{ client }, standalone, customPrompts] = await Promise.all([
      this.acquireClient(cwd, environment), standalonePromise, promptRefresh,
    ]);
    const [skillsResult, pluginsResult, configResult] = await Promise.all([
      client.listSkills(cwd ? [cwd] : undefined, forceReload),
      client.listPlugins(cwd ? [cwd] : undefined),
      client.readConfig(cwd).then((value) => ({ value }), () => ({ value: undefined })),
    ]);
    const data = this.requestedSkillContext(skillsResult, cwd);
    if (!data) throw new Error("Codex skills/list omitted the requested catalog context.");
    const reconciled = reconcileSkills(data.skills);
    const reconciledPlugins = await reconcilePlugins(client, pluginsResult);
    const registrations = configuredAgents(configResult.value?.config);
    const diagnostics = this.availableDiagnostics(data, standalone, reconciled, reconciledPlugins, registrations, configResult.value === undefined);
    const fetchedAt = new Date().toISOString();
    const snapshot: CodexCatalogRefreshResult = {
      skills: reconciled.skills,
      plugins: reconciledPlugins.plugins,
      prompts: customPrompts.prompts,
      agents: mergeAgents(standalone.agents, configResult.value === undefined ? previous?.agents ?? [] : registrations.agents),
      diagnostics: [...diagnostics, ...customPrompts.diagnostics].slice(0, PROVIDER_CATALOG_MAX_DIAGNOSTICS),
      freshness: customPrompts.available ? { status: "fresh", fetchedAt } : { status: "stale", fetchedAt, reason: "Codex custom prompt discovery failed." },
      skillsAvailable: true,
      promptsAvailable: customPrompts.available,
    };
    this.snapshots.set(catalogKey(cwd), snapshot);
    return snapshot;
  }

  private requestedSkillContext(skillsResult: unknown, cwd: string | undefined): Record<string, unknown> | undefined {
    const rawData = Array.isArray((skillsResult as { data?: unknown }).data)
      ? (skillsResult as { data: unknown[] }).data
      : [];
    return cwd
      ? rawData.find((item) => item && typeof item === "object" && (item as Record<string, unknown>).cwd === cwd) as Record<string, unknown> | undefined
      : rawData[0] as Record<string, unknown> | undefined;
  }

  private availableDiagnostics(
    data: Record<string, unknown>,
    standalone: CodexCatalogAgentDiscovery,
    reconciled: ReturnType<typeof reconcileSkills>,
    plugins: Awaited<ReturnType<typeof reconcilePlugins>>,
    registrations: ReturnType<typeof configuredAgents>,
    configUnavailable: boolean,
  ): ProviderCatalogSourceDiagnostic[] {
    const diagnostics = [...upstreamDiagnostics(data.errors), ...standalone.diagnostics, ...plugins.diagnostics];
    if (configUnavailable) diagnostics.push(sourceDiagnostic("appServerConfig", "config/read", "source-unavailable", "Codex agent registrations are temporarily unavailable for this catalog context."));
    if (registrations.invalidMetadata) diagnostics.push(sourceDiagnostic("appServerConfig", "agents", "partial-result", "Some Codex agent registrations were omitted because their metadata was invalid."));
    if (registrations.entryLimitReached) diagnostics.push(sourceDiagnostic("appServerConfig", "agents", "partial-result", `Codex agent registrations were capped at ${PROVIDER_CATALOG_MAX_SELECTABLE_AGENTS} entries.`));
    if (reconciled.invalidMetadata) diagnostics.push(sourceDiagnostic("appServerSkills", "skills/list", "partial-result", "Some Codex Skills were omitted because their metadata was invalid."));
    if (reconciled.entryLimitReached) diagnostics.push(sourceDiagnostic("appServerSkills", "skills/list", "partial-result", `Codex Skills were capped at ${PROVIDER_CATALOG_MAX_ENTRIES} entries.`));
    return diagnostics;
  }

  private async refreshUnavailableCatalog(
    cwd: string | undefined,
    previous: CodexCatalogRefreshResult | undefined,
    promptRefresh: Promise<CodexCustomPromptDiscoveryResult>,
    standalonePromise: Promise<CodexCatalogAgentDiscovery>,
    error: unknown,
  ): Promise<CodexCatalogRefreshResult> {
    const [customPrompts, standalone] = await Promise.all([promptRefresh, standalonePromise]);
    const standaloneIsFresh = standalone.agents.length > 0;
    const prior = this.previousCatalogData(previous);
    const fetchedAt = standaloneIsFresh ? new Date().toISOString() : prior.fetchedAt;
    logger.warn("Codex catalog refresh failed", { cwd, error: error instanceof Error ? error.message : String(error) });
    const snapshot: CodexCatalogRefreshResult = {
      skills: prior.skills,
      plugins: prior.plugins,
      prompts: customPrompts.prompts,
      agents: mergeAgents(standalone.agents, prior.agents),
      diagnostics: [...standalone.diagnostics, sourceDiagnostic("providerCatalog", "codex app-server", "source-unavailable", "Codex capabilities and agent registrations are temporarily unavailable for this catalog context."), ...customPrompts.diagnostics].slice(0, PROVIDER_CATALOG_MAX_DIAGNOSTICS),
      freshness: standaloneIsFresh ? { status: "fresh", fetchedAt } : { status: "stale", fetchedAt, reason: "Codex capability discovery failed." },
      skillsAvailable: false,
      promptsAvailable: customPrompts.available,
    };
    this.snapshots.set(catalogKey(cwd), snapshot);
    return snapshot;
  }

  private previousCatalogData(previous: CodexCatalogRefreshResult | undefined): {
    skills: SkillInfo[];
    plugins: ProviderPluginCapability[];
    agents: SelectableProviderAgent[];
    fetchedAt: string;
  } {
    if (!previous) return { skills: [], plugins: [], agents: [], fetchedAt: new Date().toISOString() };
    return {
      skills: previous.skills,
      plugins: previous.plugins,
      agents: previous.agents,
      fetchedAt: previous.freshness.fetchedAt,
    };
  }

  private async acquireClient(
    cwd?: string,
    requestedEnvironment?: Record<string, string>,
  ): Promise<{
    client: CodexCatalogClient;
    environment: Record<string, string>;
  }> {
    const active = await this.activeCatalogClient();
    if (active) return active;
    const environment = requestedEnvironment ?? this.envService.getEnv();
    const client = this.createCatalogClient(cwd, environment);
    return this.startCatalogClient(client, environment);
  }

  private async activeCatalogClient(): Promise<{ client: CodexCatalogClient; environment: Record<string, string> } | undefined> {
    if (this.client?.isAlive && this.clientEnvironment) {
      return { client: this.client, environment: this.clientEnvironment };
    }
    if (this.startPromise && this.clientEnvironment) {
      return { client: await this.startPromise, environment: this.clientEnvironment };
    }
    return undefined;
  }

  private createCatalogClient(cwd: string | undefined, environment: Record<string, string>): CodexCatalogClient {
    const settings = this.settingsService.get();
    return this.clientFactory.create({
      cliPath: settings.provider.cli.codex || "codex",
      workingDirectory: cwd ?? process.cwd(),
      processAttachment: {
        attach: (pid, description) => {
          if (!this.jobObject.isWindowsJob) return;
          this.jobObject.assign(pid);
          this.jobObject.setDescription(pid, description);
        },
      },
      getSpawnEnv: () => ({ ...environment }),
    });
  }

  private async startCatalogClient(
    client: CodexCatalogClient,
    environment: Record<string, string>,
  ): Promise<{ client: CodexCatalogClient; environment: Record<string, string> }> {
    this.client = client;
    this.clientEnvironment = environment;
    client.on("notification", (notification: unknown) => {
      this.handleNotification(notification);
    });
    this.startPromise = client.start().then(() => client);
    try {
      return { client: await this.startPromise, environment };
    } catch (error) {
      if (this.client === client) this.client = null;
      if (this.client === null) this.clientEnvironment = null;
      await client.kill().catch(() => undefined);
      throw error;
    } finally {
      this.startPromise = null;
    }
  }

  private armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.evictIdleClient();
    }, CODEX_CATALOG_IDLE_TTL_MS);
    this.idleTimer.unref?.();
  }

  private async evictIdleClient(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.clientEnvironment = null;
    this.startPromise = null;
    await client?.kill();
  }

  private rememberContext(cwd?: string): void {
    const key = catalogKey(cwd);
    this.requestedContexts.delete(key);
    this.requestedContexts.set(key, cwd);

    const snapshot = this.snapshots.get(key);
    if (snapshot) {
      this.snapshots.delete(key);
      this.snapshots.set(key, snapshot);
    }

    while (this.requestedContexts.size > CODEX_CATALOG_MAX_CONTEXTS) {
      const oldestKey = this.requestedContexts.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.requestedContexts.delete(oldestKey);
      this.snapshots.delete(oldestKey);
    }
  }

  private handleNotification(notification: unknown): void {
    const params = this.skillsChangedParams(notification);
    if (!params) return;
    const signaledCwds = this.signaledCwds(params);
    const hasExplicitContexts = this.hasExplicitContexts(params);
    if (hasExplicitContexts && signaledCwds.length === 0) return;
    const contexts = signaledCwds.length > 0
      ? signaledCwds
          .map((cwd) => this.requestedContexts.get(catalogKey(cwd)))
          .filter((cwd): cwd is string => cwd !== undefined)
      : [...this.requestedContexts.values()];

    void this.refreshChangedContexts(contexts);
  }

  private skillsChangedParams(notification: unknown): { cwd?: unknown; cwds?: unknown } | undefined {
    if (!notification || typeof notification !== "object") return undefined;
    const value = notification as { method?: unknown; params?: unknown };
    if (value.method !== "skills/changed" || !value.params || typeof value.params !== "object") return undefined;
    return value.params as { cwd?: unknown; cwds?: unknown };
  }

  private signaledCwds(params: { cwd?: unknown; cwds?: unknown }): string[] {
    const primary = this.isValidCwd(params.cwd) ? [params.cwd] : [];
    const secondary = Array.isArray(params.cwds) ? params.cwds.filter(this.isValidCwd) : [];
    return Array.from(new Set([...primary, ...secondary])).slice(0, CODEX_CATALOG_MAX_CONTEXTS);
  }

  private hasExplicitContexts(params: { cwd?: unknown; cwds?: unknown }): boolean {
    return params.cwd !== undefined || params.cwds !== undefined;
  }

  private isValidCwd(cwd: unknown): cwd is string {
    return typeof cwd === "string" && cwd.length > 0 && cwd.length <= CODEX_CATALOG_MAX_CWD_LENGTH;
  }

  private async refreshChangedContexts(contexts: readonly (string | undefined)[]): Promise<void> {
    for (const cwd of contexts.slice(0, CODEX_CATALOG_MAX_CONTEXTS)) {
      await this.refreshContext(cwd, true);
      for (const handler of this.skillsChangedHandlers) {
        try {
          handler(cwd);
        } catch (error) {
          logger.debug("Codex catalog skills-changed subscriber failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }
}
