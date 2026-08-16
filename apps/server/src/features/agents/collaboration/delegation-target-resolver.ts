import type {
  IProviderRegistry,
  ProviderId,
  ThreadCreateInput,
  ThreadTargetListResult,
} from "@mcode/contracts";
import { getCatalogEntry } from "@mcode/contracts";
import { inject, injectable } from "tsyringe";
import { ModelCacheService } from "../../providers/models/model-cache-service.js";
import { ProviderAvailabilityService } from "../../providers/availability/provider-availability-service.js";
import { SettingsService } from "../../../shared/settings/settings-service.js";

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
      try {
        this.availability?.assertUsable(provider.id);
        const models = await this.models.listModels(provider.id);
        const usableModels = this.usableModels(models);
        if (usableModels.length === 0) continue;
        const globalDefaultModel = globalProviderId === provider.id
          ? globalModelId
          : undefined;
        const defaultModelId = globalDefaultModel && usableModels.some((model) => model.id === globalDefaultModel)
          ? globalDefaultModel
          : undefined;
        targets.push({
          providerId: provider.id,
          name: catalog.name,
          models: usableModels.slice(0, 100).map((model) => ({
            id: model.id,
            name: model.name.trim() || model.id,
          })),
          ...(defaultModelId ? { defaultModelId } : {}),
        });
      } catch {
        // Discovery is best-effort. Unavailable providers are omitted without diagnostics.
      }
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
    let provider;
    try {
      provider = this.providers.resolve(providerId);
    } catch {
      return { status: "invalid_provider" };
    }
    const explicitProvider = input.providerId !== undefined;
    const requiresExplicitModel = explicitProvider
      && input.modelId === undefined
      && providerId !== globalProviderId;
    let modelId = input.modelId;
    if (modelId === undefined) {
      if (requiresExplicitModel) return { status: "model_required" };
      modelId = globalModelId;
    }
    try {
      this.availability?.assertUsable(provider.id);
      const models = this.usableModels(await this.models.listModels(provider.id));
      if (!models.some((model) => model.id === modelId)) {
        return requiresExplicitModel ? { status: "model_required" } : { status: "invalid_model" };
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("No provider registered")) {
        return { status: "invalid_provider" };
      }
      return { status: "discovery_failed" };
    }
    return { status: "resolved", providerId: provider.id, modelId };
  }

  private usableModels(models: Awaited<ReturnType<ModelCacheService["listModels"]>>) {
    return models.filter((model) => model.id.trim().length > 0 && model.policy?.state !== "disabled");
  }
}
