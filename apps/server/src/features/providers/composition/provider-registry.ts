/**
 * Provider registry.
 * Resolves provider instances by ID, collecting all registered IAgentProvider tokens.
 */

import { injectable, injectAll } from "tsyringe";
import type {
  IAgentProvider,
  IProviderRegistry,
  ProviderId,
} from "@mcode/contracts";

/** Resolves registered provider instances by their ProviderId. */
@injectable()
export class ProviderRegistry implements IProviderRegistry {
  private readonly providers: Map<ProviderId, IAgentProvider>;

  constructor(
    @injectAll("IAgentProvider")
    registeredProviders: IAgentProvider[],
  ) {
    this.providers = new Map(
      registeredProviders.map((p) => [p.id, p]),
    );
  }

  /** Get a single provider by ID. Throws if not registered. */
  resolve(id: ProviderId): IAgentProvider {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new Error(`No provider registered with id: ${id}`);
    }
    return provider;
  }

  /** Get all registered providers. */
  resolveAll(): IAgentProvider[] {
    return [...this.providers.values()];
  }

  /** Shut down all providers. */
  shutdown(): void {
    for (const provider of this.providers.values()) {
      provider.shutdown();
    }
  }
}
