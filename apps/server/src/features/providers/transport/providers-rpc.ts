import type {
  IProviderRegistry,
  ProviderCapabilityKind,
  ProviderCatalogContext,
  ProviderCatalogRequest,
  ProviderUsageInfo,
  WsMethodName,
} from "@mcode/contracts";
import { logger } from "@mcode/shared";
import type { HostRuntime } from "@mcode/shared/node/host-runtime";
import { discoverCopilotAgents } from "../adapters/copilot/copilot-agent-discovery.js";
import type { ProviderAvailabilityService } from "../availability/provider-availability-service.js";
import type {
  CodexCatalogRefreshResult,
  CodexCatalogService,
} from "../catalog/codex-catalog-service.js";
import type { ProviderCatalogService } from "../catalog/provider-catalog-service.js";
import type { ConfigService } from "../configuration/config-service.js";
import type { ModelCacheService } from "../models/model-cache-service.js";
import type { SkillService } from "../../agents/skills/catalog/skill-service.js";
import type { GitWorktreeService } from "../../projects/git/git-worktree-service.js";
import type { WorkspaceService } from "../../projects/lifecycle/workspace-service.js";
import type { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import { buildProviderCatalogSnapshot } from "./provider-catalog.js";

type ProviderRpcMethod = Extract<
  WsMethodName,
  | "config.discover"
  | "provider.catalog"
  | "provider.listModels"
  | "provider.getUsage"
  | "providers.listAvailability"
  | "provider.copilotAgents"
>;

type ProviderIdParams = {
  providerId: ProviderCatalogRequest["providerId"];
};

type ProviderRpcParamsByMethod = {
  "config.discover": { workspacePath: string };
  "provider.catalog": ProviderCatalogRequest;
  "provider.listModels": ProviderIdParams;
  "provider.getUsage": ProviderIdParams;
  "providers.listAvailability": Record<never, never>;
  "provider.copilotAgents": { workspaceId: string };
};

/** Defines the dependencies required by provider transport routes. */
export interface ProviderRouterDeps {
  runtime: Pick<HostRuntime, "platform">;
  configService: Pick<ConfigService, "discover">;
  workspaceService: Pick<WorkspaceService, "findById">;
  threadRepo: Pick<ThreadRepo, "findById">;
  gitWorktrees: Pick<GitWorktreeService, "resolveWorkingDir">;
  skillService: Pick<SkillService, "list">;
  codexCatalogService: Pick<CodexCatalogService, "currentSnapshot" | "refresh">;
  providerCatalogService: Pick<ProviderCatalogService, "request">;
  providerAvailability: Pick<
    ProviderAvailabilityService,
    "assertEnabled" | "assertUsable" | "listAvailability"
  >;
  modelCacheService: Pick<ModelCacheService, "listModels">;
  providerRegistry: IProviderRegistry;
}

type ProviderRpcHandlerMap = {
  [Method in ProviderRpcMethod]: (
    deps: ProviderRouterDeps,
    params: ProviderRpcParamsByMethod[Method],
  ) => Promise<unknown> | unknown;
};

const providerRpcHandlers: ProviderRpcHandlerMap = {
  "config.discover": (deps, params) => deps.configService.discover(params.workspacePath),
  "provider.catalog": (deps, params) => routeProviderCatalog(deps, params),
  "provider.listModels": (deps, params) => {
    deps.providerAvailability.assertEnabled(params.providerId);
    return deps.modelCacheService.listModels(params.providerId);
  },
  "provider.getUsage": (deps, params) => routeProviderUsage(deps, params.providerId),
  "providers.listAvailability": (deps) => deps.providerAvailability.listAvailability(),
  "provider.copilotAgents": (deps, params) => routeCopilotAgents(deps, params.workspaceId),
};

/** Checks whether a method belongs to the Provider transport route family. */
export function isProviderRpcMethod(method: string): method is ProviderRpcMethod {
  return Object.hasOwn(providerRpcHandlers, method);
}

/** Routes validated Provider RPC parameters to the Provider feature. */
export async function routeProviderRpc<Method extends ProviderRpcMethod>(
  method: Method,
  params: ProviderRpcParamsByMethod[Method],
  deps: ProviderRouterDeps,
): Promise<unknown> {
  return await providerRpcHandlers[method](deps, params);
}

function routeProviderCatalog(
  deps: ProviderRouterDeps,
  params: ProviderCatalogRequest,
) {
  const { cwd, context } = resolveProviderCatalogContext(deps, params);
  const workspaceRoot = params.workspaceId
    ? deps.workspaceService.findById(params.workspaceId)?.path
    : undefined;
  const buildSnapshot = (catalog?: CodexCatalogRefreshResult) => buildCatalogSnapshot(
    deps,
    params,
    context,
    cwd,
    catalog,
  );
  return deps.providerCatalogService.request({
    request: params,
    context,
    cwd,
    ...(params.threadId && workspaceRoot ? { fallbackCwd: workspaceRoot } : {}),
    refresh: async () => refreshProviderCatalog(deps, params, cwd, buildSnapshot),
    ...(params.providerId === "codex" ? {
      refreshFromCache: async () => buildSnapshot(deps.codexCatalogService.currentSnapshot(cwd)),
    } : {}),
  });
}

function buildCatalogSnapshot(
  deps: ProviderRouterDeps,
  params: ProviderCatalogRequest,
  context: ProviderCatalogContext,
  cwd: string | undefined,
  catalog?: CodexCatalogRefreshResult,
) {
  const skills = catalog
    ? [...catalog.skills, ...catalog.prompts]
    : deps.skillService.list(cwd, params.providerId);
  return buildProviderCatalogSnapshot({
    providerId: params.providerId,
    context,
    skills,
    ...(catalog?.plugins ? { entries: catalog.plugins } : {}),
    ...(catalog?.agents ? { agents: catalog.agents } : {}),
    ...(catalog?.diagnostics ? { diagnostics: catalog.diagnostics } : {}),
    ...(catalog?.freshness ? { freshness: catalog.freshness } : {}),
  });
}

async function refreshProviderCatalog(
  deps: ProviderRouterDeps,
  params: ProviderCatalogRequest,
  cwd: string | undefined,
  buildSnapshot: (catalog?: CodexCatalogRefreshResult) => ReturnType<typeof buildProviderCatalogSnapshot>,
) {
  if (params.providerId !== "codex") return buildSnapshot();
  const catalog = await deps.codexCatalogService.refresh(cwd);
  return {
    snapshot: buildSnapshot(catalog),
    confirmedEntryKinds: confirmedCodexEntryKinds(catalog),
  };
}

function confirmedCodexEntryKinds(
  catalog: CodexCatalogRefreshResult,
): ProviderCapabilityKind[] {
  return [
    ...(catalog.skillsAvailable
      ? ["skill", "plugin", "providerCommand"] as const
      : []),
    ...(catalog.promptsAvailable ? ["customPrompt"] as const : []),
  ];
}

function resolveProviderCatalogContext(
  deps: ProviderRouterDeps,
  params: ProviderCatalogRequest,
): { cwd: string | undefined; context: ProviderCatalogContext } {
  if (params.workspaceId) {
    return {
      cwd: resolveWorkspaceRepoPath(deps, params.workspaceId, params.threadId),
      context: {
        scope: "workspace",
        workspaceId: params.workspaceId,
        ...(params.threadId ? { threadId: params.threadId } : {}),
      },
    };
  }
  if (params.cwd) {
    return { cwd: params.cwd, context: { scope: "path", cwd: params.cwd } };
  }
  return { cwd: undefined, context: { scope: "user" } };
}

function resolveWorkspaceRepoPath(
  deps: ProviderRouterDeps,
  workspaceId: string,
  threadId?: string,
): string {
  const workspace = deps.workspaceService.findById(workspaceId);
  if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
  if (!threadId) return workspace.path;

  const thread = deps.threadRepo.findById(threadId);
  if (!thread) throw new Error(`Thread not found: ${threadId}`);
  if (thread.workspace_id !== workspaceId) {
    throw new Error(`Thread ${threadId} does not belong to workspace ${workspaceId}`);
  }
  return deps.gitWorktrees.resolveWorkingDir(
    workspace.path,
    thread.mode,
    thread.worktree_path,
  );
}

async function routeProviderUsage(
  deps: ProviderRouterDeps,
  providerId: ProviderCatalogRequest["providerId"],
): Promise<ProviderUsageInfo> {
  deps.providerAvailability.assertUsable(providerId);
  const provider = deps.providerRegistry.resolve(providerId);
  if (!provider.getUsage) return unsupportedUsageSnapshot(provider.id);
  try {
    return readyUsageSnapshot(await provider.getUsage());
  } catch (error) {
    return unavailableUsageSnapshot(provider.id, error);
  }
}

function unsupportedUsageSnapshot(providerId: string): ProviderUsageInfo {
  return {
    providerId,
    quotaCategories: [],
    usageStatus: "unsupported",
    failedAt: new Date().toISOString(),
    diagnostic: "Provider usage is not supported",
  };
}

function unavailableUsageSnapshot(providerId: string, error: unknown): ProviderUsageInfo {
  const diagnostic = redactedUsageDiagnostic(error);
  logger.warn("Provider usage refresh failed", {
    providerId,
    sourceKind: "getUsage",
    lastRefreshTime: new Date().toISOString(),
    reason: diagnostic,
  });
  return {
    providerId,
    quotaCategories: [],
    usageStatus: "unavailable",
    failedAt: new Date().toISOString(),
    diagnostic,
  };
}

function readyUsageSnapshot(usage: ProviderUsageInfo): ProviderUsageInfo {
  return {
    ...usage,
    usageStatus: usage.quotaCategories.length > 0 ? "ready" : "ready-empty",
    fetchedAt: new Date().toISOString(),
    diagnostic: undefined,
    failedAt: undefined,
  };
}

function redactedUsageDiagnostic(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(token|api[_-]?key|authorization|password|secret)=\S+/gi, "$1=[redacted]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .slice(0, 240);
}

function routeCopilotAgents(deps: ProviderRouterDeps, workspaceId: string) {
  const workspace = deps.workspaceService.findById(workspaceId);
  if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
  return discoverCopilotAgents(workspace.path, deps.runtime.platform);
}
