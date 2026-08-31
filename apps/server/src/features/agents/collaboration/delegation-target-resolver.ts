import type {
  IProviderRegistry,
  IAgentProvider,
  ProviderId,
  ThreadCreateInput,
  ThreadTargetListResult,
} from "@mcode/contracts";
import { getCatalogEntry } from "@mcode/contracts";
import { inject, injectable } from "tsyringe";
import { ModelCacheService } from "../../providers/models/model-cache-service.js";
import { ProviderAvailabilityService } from "../../providers/availability/provider-availability-service.js";
import { SettingsService } from "../../settings/settings-service.js";

/** Server-side resolution result used by ThreadControlService. */
export type DelegationTargetResolution =
  | { status: "resolved"; providerId: ProviderId; modelId: string }
  | { status: "invalid_provider" }
  | { status: "model_required" }
  | { status: "invalid_model" }
  | { status: "discovery_failed" };

/**
 * Resolves the provider/model pairs that can actually accept delegated turns.
 * This is the only server authority for target discovery and exact-pair checks.
 */
@injectable()
export class DelegationTargetResolver {
  constructor(
    @inject("IProviderRegistry") private readonly providers: IProviderRegistry,
    @inject(ModelCacheService) private readonly models: ModelCacheService,
    @inject(SettingsService) private readonly settings: SettingsService,
    @inject(ProviderAvailabilityService) private readonly availability?: ProviderAvailabilityService,
  ) {}

  /** Return bounded, secret-free provider/model targets usable for delegation. */
  async listTargets(): Promise<ThreadTargetListResult> {
    const settings = this.settings.get();
    const globalProviderId = settings.model.defaults.provider;
    const globalModelId = settings.model.defaults.id.trim();
    const targets: ThreadTargetListResult["providers"] = [];
    for (const provider of this.providers.resolveAll()) {
      const catalog = getCatalogEntry(provider.id);
      if (catalog.comingSoon || !settings.provider.enabled[provider.id]) continue;
      const target = await this.listProviderTarget(
        provider.id,
        catalog.name,
        globalProviderId === provider.id ? globalModelId : undefined,
      );
      if (target) targets.push(target);
      if (targets.length >= 20) break;
    }
    return { providers: targets };
  }

  /** Resolve one requested provider/model pair against the current usable snapshot. */
  async resolve(input: Pick<ThreadCreateInput, "providerId" | "modelId">): Promise<DelegationTargetResolution> {
    const settings = this.settings.get();
    const globalProviderId = settings.model.defaults.provider;
    const globalModelId = settings.model.defaults.id.trim();
    const providerId = (input.providerId ?? globalProviderId) as ProviderId;
    const provider = this.resolveProvider(providerId);
    if (!provider) return { status: "invalid_provider" };
    const model = this.requestedModel(input, providerId, globalProviderId, globalModelId);
    if (model.status) return model.status;
    return this.resolveAvailableModel(provider, model.id, model.requiresExplicitModel);
  }

  private async listProviderTarget(
    providerId: ProviderId,
    providerName: string,
    globalDefaultModel: string | undefined,
  ): Promise<ThreadTargetListResult["providers"][number] | undefined> {
    try {
      this.availability?.assertUsable(providerId);
      const models = this.usableModels(await this.models.listModels(providerId));
      if (models.length === 0) return undefined;
      const defaultModelId = globalDefaultModel && models.some((model) => model.id === globalDefaultModel)
        ? globalDefaultModel
        : undefined;
      return {
        providerId,
        name: providerName,
        models: models.slice(0, 100).map((model) => ({
          id: model.id,
          name: model.name.trim() || model.id,
        })),
        ...(defaultModelId ? { defaultModelId } : {}),
      };
    } catch {
      // Discovery is best-effort. Unavailable providers are omitted without diagnostics.
      return undefined;
    }
  }

  private resolveProvider(providerId: ProviderId): IAgentProvider | undefined {
    try {
      return this.providers.resolve(providerId);
    } catch {
      return undefined;
    }
  }

  private requestedModel(
    input: Pick<ThreadCreateInput, "providerId" | "modelId">,
    providerId: ProviderId,
    globalProviderId: ProviderId,
    globalModelId: string,
  ):
    | { id: string; requiresExplicitModel: boolean; status?: undefined }
    | { status: Extract<DelegationTargetResolution, { status: "model_required" }> } {
    const requiresExplicitModel = input.providerId !== undefined
      && input.modelId === undefined
      && providerId !== globalProviderId;
    if (requiresExplicitModel) return { status: { status: "model_required" } };
    return { id: input.modelId ?? globalModelId, requiresExplicitModel };
  }

  private async resolveAvailableModel(
    provider: IAgentProvider,
    modelId: string,
    requiresExplicitModel: boolean,
  ): Promise<DelegationTargetResolution> {
    try {
      this.availability?.assertUsable(provider.id);
      const models = this.usableModels(await this.models.listModels(provider.id));
      if (!models.some((model) => model.id === modelId)) {
        return requiresExplicitModel ? { status: "model_required" } : { status: "invalid_model" };
      }
      return { status: "resolved", providerId: provider.id, modelId };
    } catch (error) {
      return error instanceof Error && error.message.startsWith("No provider registered")
        ? { status: "invalid_provider" }
        : { status: "discovery_failed" };
    }
  }

  private usableModels(models: Awaited<ReturnType<ModelCacheService["listModels"]>>) {
    return models.filter((model) => model.id.trim().length > 0 && model.policy?.state !== "disabled");
  }
}
