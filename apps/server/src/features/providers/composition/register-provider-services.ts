import { Lifecycle, type DependencyContainer } from "tsyringe";

import { ConfigService } from "../configuration/config-service.js";
import {
  CodexCatalogClientFactory,
  CodexCatalogService,
} from "../catalog/codex-catalog-service.js";
import { CodexCustomPromptService } from "../catalog/codex-custom-prompt-service.js";
import { ProviderCatalogService } from "../catalog/provider-catalog-service.js";
import {
  ProviderAvailabilityService,
  defaultResolver,
} from "../availability/provider-availability-service.js";
import { ProviderUsageWarmupService } from "../availability/provider-usage-warmup-service.js";
import { ModelCacheService } from "../models/model-cache-service.js";

/** Register provider configuration before catalog and terminal services. */
export function registerProviderConfiguration(container: DependencyContainer): void {
  container.register(
    ConfigService,
    { useClass: ConfigService },
    { lifecycle: Lifecycle.Singleton },
  );
}

/** Register provider catalog services in application order. */
export function registerProviderCatalogServices(container: DependencyContainer): void {
  container.register(
    CodexCatalogClientFactory,
    { useClass: CodexCatalogClientFactory },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    CodexCustomPromptService,
    { useClass: CodexCustomPromptService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    CodexCatalogService,
    { useClass: CodexCatalogService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    ProviderCatalogService,
    { useClass: ProviderCatalogService },
    { lifecycle: Lifecycle.Singleton },
  );
}

/** Register provider availability and model cache services after provider adapters. */
export function registerProviderRuntimeServices(container: DependencyContainer): void {
  container.register("CliResolver", { useValue: defaultResolver });
  container.register(
    ProviderAvailabilityService,
    { useClass: ProviderAvailabilityService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    ProviderUsageWarmupService,
    { useClass: ProviderUsageWarmupService },
    { lifecycle: Lifecycle.Singleton },
  );
  // ModelCacheService depends on the registry alias and must remain after it.
  container.register(
    ModelCacheService,
    { useClass: ModelCacheService },
    { lifecycle: Lifecycle.Singleton },
  );
}
