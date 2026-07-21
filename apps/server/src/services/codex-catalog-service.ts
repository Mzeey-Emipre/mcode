import { EventEmitter } from "events";
import { inject, injectable } from "tsyringe";
import type {
  ProviderCatalogDiagnostic,
  ProviderCatalogFreshness,
  ProviderPluginCapability,
  SkillInfo,
} from "@mcode/contracts";
import {
  PROVIDER_CATALOG_MAX_ENTRIES,
  ProviderPluginCapabilitySchema,
  SkillInfoSchema,
} from "@mcode/contracts";
import { logger } from "@mcode/shared";
import { CodexAppServer, type CodexAppServerOptions } from "../providers/codex/codex-app-server.js";
import type {
  PluginListResult,
  PluginReadParams,
  PluginReadResult,
  SkillsListResult,
} from "../providers/codex/codex-types.js";
import { codexPluginNameFromSkillPath } from "./skill-service.js";
import { SettingsService } from "./settings-service.js";
import { EnvService } from "./env-service.js";
import {
  CodexCustomPromptService,
  type CodexCustomPromptDiscoveryResult,
} from "./codex-custom-prompt-service.js";
import type { JobObject } from "./job-object.js";

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
  readonly diagnostics: ProviderCatalogDiagnostic[];
  readonly freshness: ProviderCatalogFreshness;
  readonly skillsAvailable: boolean;
  readonly promptsAvailable: boolean;
}

/** Minimal app-server surface used by the provider-wide catalog connection. */
export interface CodexCatalogClient extends EventEmitter {
  readonly isAlive: boolean;
  start(): Promise<void>;
  listSkills(cwds?: string[], forceReload?: boolean): Promise<SkillsListResult>;
  listPlugins(cwds?: string[]): Promise<PluginListResult>;
  readPlugin(params: PluginReadParams): Promise<PluginReadResult>;
  kill(): Promise<void>;
}

/** Creates the external app-server client used by {@link CodexCatalogService}. */
@injectable()
export class CodexCatalogClientFactory {
  /** Creates one catalog-only Codex app-server client. */
  create(options: CodexAppServerOptions): CodexCatalogClient {
    return new CodexAppServer(options);
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

function mapSkill(skill: unknown): SkillInfo | undefined {
  if (!skill || typeof skill !== "object") return undefined;
  const value = skill as Record<string, unknown>;
  if (value.enabled !== true || typeof value.name !== "string" || typeof value.path !== "string") {
    return undefined;
  }
  const interfaceValue = value.interface && typeof value.interface === "object"
    ? value.interface as Record<string, unknown>
    : undefined;
  const description = [
    interfaceValue?.shortDescription,
    value.shortDescription,
    value.description,
  ].find((candidate): candidate is string => typeof candidate === "string") ?? "";
  const scope = typeof value.scope === "string" ? value.scope : "";
  const parsed = SkillInfoSchema().safeParse({
    name: value.name,
    description,
    kind: "skill",
    source: skillSource(value.path, scope),
    providers: ["codex"],
    nativeName: value.name,
    path: value.path,
  });
  return parsed.success ? parsed.data : undefined;
}

function boundedDiagnosticMessage(message: string): string {
  const normalized = message.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return normalized.slice(0, 900) || "Codex did not provide a diagnostic message.";
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

function upstreamDiagnostics(rawErrors: unknown): ProviderCatalogDiagnostic[] {
  if (!Array.isArray(rawErrors)) return [];
  return rawErrors.slice(0, 90).flatMap((error) => {
    const message = error && typeof error === "object"
      ? (error as Record<string, unknown>).message
      : undefined;
    return typeof message === "string"
      ? [{
          severity: "warning" as const,
          code: "discovery-error" as const,
          message: boundedDiagnosticMessage(message),
        }]
      : [];
  });
}

function pluginDetailDescription(result: PluginReadResult): string {
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
): PluginReadParams {
  return marketplacePath
    ? { marketplacePath, pluginName }
    : { remoteMarketplaceName: marketplaceName, pluginName };
}

async function readMissingPluginDescriptions(
  client: CodexCatalogClient,
  candidates: PluginCandidate[],
  diagnostics: ProviderCatalogDiagnostic[],
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
        diagnostics.push({
          severity: "warning",
          code: "partial-result",
          message: boundedDiagnosticMessage(
            `Codex plugin details are unavailable for ${pluginId}.`,
          ),
        });
      }
    }
  };

  await Promise.all(Array.from(
    { length: Math.min(CODEX_CATALOG_PLUGIN_DETAIL_CONCURRENCY, selected.length) },
    worker,
  ));
  if (missing.length > CODEX_CATALOG_MAX_PLUGIN_DETAIL_READS) {
    diagnostics.push({
      severity: "warning",
      code: "partial-result",
      message: `Codex plugin detail reads were capped at ${CODEX_CATALOG_MAX_PLUGIN_DETAIL_READS} entries.`,
    });
  }
  return descriptions;
}

async function reconcilePlugins(
  client: CodexCatalogClient,
  result: PluginListResult,
): Promise<{
  plugins: ProviderPluginCapability[];
  diagnostics: ProviderCatalogDiagnostic[];
}> {
  const diagnostics: ProviderCatalogDiagnostic[] = (Array.isArray(result.marketplaceLoadErrors)
    ? result.marketplaceLoadErrors
    : []).slice(0, 90).flatMap((error) => {
      if (
        !error ||
        typeof error.marketplacePath !== "string" ||
        typeof error.message !== "string"
      ) {
        return [];
      }
      return [{
        severity: "warning" as const,
        code: "discovery-error" as const,
        message: boundedDiagnosticMessage(
          `Codex plugin marketplace ${error.marketplacePath}: ${error.message}`,
        ),
      }];
    });
  const candidates: PluginCandidate[] = [];

  for (const rawMarketplace of Array.isArray(result.marketplaces) ? result.marketplaces : []) {
    if (!rawMarketplace || typeof rawMarketplace !== "object") continue;
    const marketplace = rawMarketplace as unknown as Record<string, unknown>;
    if (typeof marketplace.name !== "string" || !Array.isArray(marketplace.plugins)) continue;
    const marketplacePath = typeof marketplace.path === "string" ? marketplace.path : null;
    for (const rawPlugin of marketplace.plugins) {
      if (!rawPlugin || typeof rawPlugin !== "object") continue;
      const summary = rawPlugin as Record<string, unknown>;
      if (summary.installed !== true || summary.enabled !== true) continue;
      candidates.push({
        marketplaceName: marketplace.name,
        marketplacePath,
        summary,
      });
    }
  }

  const selectedCandidates = candidates.slice(0, PROVIDER_CATALOG_MAX_ENTRIES);
  const detailDescriptions = await readMissingPluginDescriptions(
    client,
    selectedCandidates,
    diagnostics,
  );
  const pluginsById = new Map<string, ProviderPluginCapability>();
  let invalidMetadata = false;
  for (const candidate of selectedCandidates) {
    const { marketplaceName, summary } = candidate;
    if (typeof summary.id !== "string" || typeof summary.name !== "string") {
      invalidMetadata = true;
      continue;
    }
    const interfaceValue = summary.interface && typeof summary.interface === "object"
      ? summary.interface as Record<string, unknown>
      : undefined;
    const description = pluginSummaryDescription(summary) || detailDescriptions.get(summary.id) || "";
    const name = typeof interfaceValue?.displayName === "string" && interfaceValue.displayName.trim()
      ? interfaceValue.displayName.trim()
      : summary.name;
    const version = [summary.localVersion, summary.version]
      .find((value): value is string => typeof value === "string" && value.trim().length > 0)
      ?.trim();
    const developerName = typeof interfaceValue?.developerName === "string" && interfaceValue.developerName.trim()
      ? interfaceValue.developerName.trim()
      : undefined;
    const capabilities = Array.isArray(interfaceValue?.capabilities)
      ? interfaceValue.capabilities
          .filter((value): value is string => typeof value === "string")
          .slice(0, 100)
      : [];
    const parsed = ProviderPluginCapabilitySchema().safeParse({
      kind: "plugin",
      identity: { providerId: "codex", kind: "plugin", nativeId: summary.id },
      name,
      description,
      mentionPath: `plugin://${summary.id}`,
      marketplaceName,
      ...(version ? { version } : {}),
      ...(developerName ? { developerName } : {}),
      capabilities,
    });
    if (parsed.success) pluginsById.set(parsed.data.identity.nativeId, parsed.data);
    else invalidMetadata = true;
  }
  if (candidates.length > PROVIDER_CATALOG_MAX_ENTRIES) {
    diagnostics.push({
      severity: "warning",
      code: "partial-result",
      message: `Codex plugins were capped at ${PROVIDER_CATALOG_MAX_ENTRIES} entries.`,
    });
  }
  if (invalidMetadata) {
    diagnostics.push({
      severity: "warning",
      code: "partial-result",
      message: "Some Codex plugins were omitted because their metadata was invalid.",
    });
  }
  return {
    plugins: [...pluginsById.values()],
    diagnostics: diagnostics.slice(0, 100),
  };
}

/** Owns one lazy, thread-independent Codex app-server connection for capability catalogs. */
@injectable()
export class CodexCatalogService {
  private client: CodexCatalogClient | null = null;
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

  /** Refreshes native Skills, plugins, and bounded custom prompts for one working-directory context. */
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
    this.startPromise = null;
    await client?.kill();
  }

  private async refreshContext(
    cwd: string | undefined,
    forceReload: boolean,
  ): Promise<CodexCatalogRefreshResult> {
    const promptRefresh = this.customPromptService.refresh();
    try {
      const client = await this.acquireClient(cwd);
      const [skillsResult, pluginsResult, customPrompts] = await Promise.all([
        client.listSkills(cwd ? [cwd] : undefined, forceReload),
        client.listPlugins(cwd ? [cwd] : undefined),
        promptRefresh,
      ]);
      const rawData = Array.isArray((skillsResult as { data?: unknown }).data)
        ? (skillsResult as { data: unknown[] }).data
        : [];
      const data = (cwd
        ? rawData.find((item) => (
            item && typeof item === "object" && (item as Record<string, unknown>).cwd === cwd
          ))
        : rawData[0]) as Record<string, unknown> | undefined;
      if (!data) {
        throw new Error("Codex skills/list omitted the requested catalog context.");
      }
      const reconciled = reconcileSkills(data?.skills);
      const diagnostics = upstreamDiagnostics(data?.errors);
      const reconciledPlugins = await reconcilePlugins(client, pluginsResult);
      diagnostics.push(...reconciledPlugins.diagnostics);
      if (reconciled.invalidMetadata) {
        diagnostics.push({
          severity: "warning",
          code: "partial-result",
          message: "Some Codex Skills were omitted because their metadata was invalid.",
        });
      }
      if (reconciled.entryLimitReached) {
        diagnostics.push({
          severity: "warning",
          code: "partial-result",
          message: `Codex Skills were capped at ${PROVIDER_CATALOG_MAX_ENTRIES} entries.`,
        });
      }
      const fetchedAt = new Date().toISOString();
      const snapshot: CodexCatalogRefreshResult = {
        skills: reconciled.skills,
        plugins: reconciledPlugins.plugins,
        prompts: customPrompts.prompts,
        diagnostics: [...diagnostics, ...customPrompts.diagnostics].slice(0, 100),
        freshness: customPrompts.available
          ? { status: "fresh", fetchedAt }
          : {
              status: "stale",
              fetchedAt,
              reason: "Codex custom prompt discovery failed.",
            },
        skillsAvailable: true,
        promptsAvailable: customPrompts.available,
      };
      this.snapshots.set(catalogKey(cwd), snapshot);
      return snapshot;
    } catch (error) {
      const customPrompts = await promptRefresh;
      const previous = this.snapshots.get(catalogKey(cwd));
      const fetchedAt = previous?.freshness.fetchedAt ?? new Date().toISOString();
      logger.warn("Codex catalog refresh failed", {
        cwd,
        error: error instanceof Error ? error.message : String(error),
      });
      const snapshot: CodexCatalogRefreshResult = {
        skills: previous?.skills ?? [],
        plugins: previous?.plugins ?? [],
        prompts: customPrompts.prompts,
        diagnostics: [
          {
            severity: "warning" as const,
            code: "source-unavailable" as const,
            message: "Codex capabilities are temporarily unavailable for this catalog context.",
          },
          ...customPrompts.diagnostics,
        ].slice(0, 100),
        freshness: {
          status: "stale",
          fetchedAt,
          reason: "Codex capability discovery failed.",
        },
        skillsAvailable: false,
        promptsAvailable: customPrompts.available,
      };
      this.snapshots.set(catalogKey(cwd), snapshot);
      return snapshot;
    }
  }

  private async acquireClient(cwd?: string): Promise<CodexCatalogClient> {
    if (this.client?.isAlive) return this.client;
    if (this.startPromise) return this.startPromise;

    const settings = this.settingsService.get();
    const client = this.clientFactory.create({
      cliPath: settings.provider.cli.codex || "codex",
      workingDirectory: cwd ?? process.cwd(),
      approvalPolicy: "never",
      catalogOnly: true,
      jobObject: this.jobObject,
      getSpawnEnv: () => this.envService.getEnv(),
    });
    this.client = client;
    client.on("notification", (notification: unknown) => {
      this.handleNotification(notification);
    });
    this.startPromise = client.start().then(() => client);
    try {
      return await this.startPromise;
    } catch (error) {
      if (this.client === client) this.client = null;
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
    if (!notification || typeof notification !== "object") return;
    const value = notification as { method?: unknown; params?: unknown };
    if (value.method !== "skills/changed") return;

    const params = value.params && typeof value.params === "object"
      ? value.params as { cwd?: unknown; cwds?: unknown }
      : undefined;
    const isValidCwd = (cwd: unknown): cwd is string => (
      typeof cwd === "string" && cwd.length > 0 && cwd.length <= CODEX_CATALOG_MAX_CWD_LENGTH
    );
    const signaledCwds = [...new Set([
      ...(isValidCwd(params?.cwd) ? [params.cwd] : []),
      ...(Array.isArray(params?.cwds) ? params.cwds.filter(isValidCwd) : []),
    ])].slice(0, CODEX_CATALOG_MAX_CONTEXTS);
    const hasExplicitContexts = params?.cwd !== undefined || params?.cwds !== undefined;
    if (hasExplicitContexts && signaledCwds.length === 0) return;
    const contexts = signaledCwds.length > 0
      ? signaledCwds
          .map((cwd) => this.requestedContexts.get(catalogKey(cwd)))
          .filter((cwd): cwd is string => cwd !== undefined)
      : [...this.requestedContexts.values()];

    void this.refreshChangedContexts(contexts);
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
