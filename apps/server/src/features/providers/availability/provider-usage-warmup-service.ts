import { inject, injectable } from "tsyringe";
import type { IAgentProvider, IProviderRegistry } from "@mcode/contracts";
import { logger } from "@mcode/shared";
import { SettingsService } from "../../../shared/settings/settings-service.js";

interface WarmableUsageProvider extends IAgentProvider {
  warmUsageCache?: (force?: boolean) => Promise<unknown>;
}

/**
 * Primes provider-owned usage caches for enabled providers before users open
 * usage UI on threads that have not sent a message yet.
 */
@injectable()
export class ProviderUsageWarmupService {
  constructor(
    @inject(SettingsService) private readonly settings: SettingsService,
    @inject("IProviderRegistry") private readonly registry: IProviderRegistry,
  ) {}

  /** Starts one non-blocking usage refresh per enabled provider that exposes usage. */
  warmEnabledProviders(force = false): void {
    const enabled = this.settings.get().provider.enabled;
    for (const provider of this.registry.resolveAll()) {
      if (!enabled[provider.id] || !provider.getUsage) continue;
      void this.warmProvider(provider as WarmableUsageProvider, force);
    }
  }

  private async warmProvider(provider: WarmableUsageProvider, force: boolean): Promise<void> {
    try {
      if (provider.warmUsageCache) {
        await provider.warmUsageCache(force);
        return;
      }
      await provider.getUsage?.();
    } catch (error) {
      logger.debug("Provider usage warm-up failed", {
        providerId: provider.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
