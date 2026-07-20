import { EventEmitter } from "events";
import { inject, injectable } from "tsyringe";
import type {
  ProviderCatalogDiagnostic,
  ProviderCatalogFreshness,
  SkillInfo,
} from "@mcode/contracts";
import {
  PROVIDER_CATALOG_MAX_ENTRIES,
  SkillInfoSchema,
} from "@mcode/contracts";
import { logger } from "@mcode/shared";
import { CodexAppServer, type CodexAppServerOptions } from "../providers/codex/codex-app-server.js";
import type {
  SkillsListResult,
} from "../providers/codex/codex-types.js";
import { codexPluginNameFromSkillPath } from "./skill-service.js";
import { SettingsService } from "./settings-service.js";
import { EnvService } from "./env-service.js";
import type { JobObject } from "./job-object.js";

const CODEX_CATALOG_IDLE_TTL_MS = 60_000;
const CODEX_CATALOG_MAX_CONTEXTS = 64;
const CODEX_CATALOG_MAX_CWD_LENGTH = 4_096;

/** Result of refreshing native Codex Skills for one working-directory context. */
export interface CodexCatalogRefreshResult {
  readonly skills: SkillInfo[];
  readonly diagnostics: ProviderCatalogDiagnostic[];
  readonly freshness: ProviderCatalogFreshness;
}

/** Minimal app-server surface used by the provider-wide catalog connection. */
export interface CodexCatalogClient extends EventEmitter {
  readonly isAlive: boolean;
  start(): Promise<void>;
  listSkills(cwds?: string[], forceReload?: boolean): Promise<SkillsListResult>;
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

/** Owns one lazy, thread-independent Codex app-server connection for Skill catalogs. */
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
  ) {}

  /** Refreshes the complete native Skill list for one working-directory context. */
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
    try {
      const client = await this.acquireClient(cwd);
      const result = await client.listSkills(cwd ? [cwd] : undefined, forceReload);
      const rawData = Array.isArray((result as { data?: unknown }).data)
        ? (result as { data: unknown[] }).data
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
        diagnostics,
        freshness: { status: "fresh", fetchedAt },
      };
      this.snapshots.set(catalogKey(cwd), snapshot);
      return snapshot;
    } catch (error) {
      const previous = this.snapshots.get(catalogKey(cwd));
      const fetchedAt = previous?.freshness.fetchedAt ?? new Date().toISOString();
      logger.warn("Codex catalog refresh failed", {
        cwd,
        error: error instanceof Error ? error.message : String(error),
      });
      const snapshot: CodexCatalogRefreshResult = {
        skills: previous?.skills ?? [],
        diagnostics: [{
          severity: "warning",
          code: "source-unavailable",
          message: "Codex Skills are temporarily unavailable for this catalog context.",
        }],
        freshness: {
          status: "stale",
          fetchedAt,
          reason: "Codex Skill discovery failed.",
        },
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
