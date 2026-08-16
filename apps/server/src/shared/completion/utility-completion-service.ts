import { injectable, inject } from "tsyringe";
import { logger } from "@mcode/shared";
import { isCompletionCapable } from "@mcode/contracts";
import type { CompletionOptions, IProviderRegistry, ProviderId } from "@mcode/contracts";
import { SettingsService } from "../../features/settings/settings-service.js";
import { ProviderAvailabilityService } from "../../features/providers/availability/provider-availability-service.js";

/** Per-provider default model IDs for utility tasks. */
const UTILITY_MODEL_DEFAULTS: Record<string, string> = {
  claude: "claude-haiku-4-5-20251001",
  copilot: "gpt-4.1-mini",
};

/**
 * Middleware that resolves the configured utility provider+model
 * and exposes a single `complete()` method for all lightweight AI tasks.
 */
@injectable()
export class UtilityCompletionService {
  constructor(
    @inject(SettingsService)
    private readonly settingsService: SettingsService,
    @inject("IProviderRegistry")
    private readonly providerRegistry: IProviderRegistry,
    @inject(ProviderAvailabilityService)
    private readonly availability: ProviderAvailabilityService,
  ) {}

  /**
   * Run a one-shot completion using the configured utility model.
   * Returns the generated text and the model ID that produced it.
   */
  async complete(prompt: string, cwd: string, options: CompletionOptions = {}): Promise<{ text: string; model: string }> {
    const settings = this.settingsService.get();
    const { provider: resolvedProvider, model: resolvedModel } =
      this.resolveProviderAndModel(settings);

    let provider = resolvedProvider;
    let model = resolvedModel;
    this.availability.assertUsable(provider);

    let agent = this.providerRegistry.resolve(provider);

    if (!isCompletionCapable(agent)) {
      logger.warn(
        `Utility provider "${provider}" does not support completion, falling back to claude`,
      );
      provider = "claude" as ProviderId;
      model = "";
      this.availability.assertUsable(provider);
      agent = this.providerRegistry.resolve(provider);

      if (!isCompletionCapable(agent)) {
        throw new Error("No completion-capable provider available for utility tasks");
      }
    }

    model = model || UTILITY_MODEL_DEFAULTS[provider] || "claude-haiku-4-5-20251001";

    const text = await agent.complete(prompt, model, cwd, options);
    return { text, model };
  }

  private resolveProviderAndModel(settings: {
    model: {
      defaults: { provider: string };
      utility: { provider: string; id: string };
    };
  }): { provider: ProviderId; model: string } {
    const utilityProvider = settings.model.utility.provider;
    const defaultsProvider = settings.model.defaults.provider;

    const provider = (utilityProvider || defaultsProvider || "claude") as ProviderId;
    const model = settings.model.utility.id;

    return { provider, model };
  }
}
