import type { ProviderId } from "@mcode/contracts";

/** Thrown when a caller requests a provider whose enabled flag is false (or comingSoon). */
export class ProviderDisabledError extends Error {
  readonly code = "PROVIDER_DISABLED" as const;
  constructor(public readonly providerId: ProviderId) {
    super(`Provider "${providerId}" is disabled`);
    this.name = "ProviderDisabledError";
  }
}

/** Thrown when a provider is enabled but its CLI binary could not be resolved. */
export class ProviderCliMissingError extends Error {
  readonly code = "PROVIDER_CLI_MISSING" as const;
  constructor(
    public readonly providerId: ProviderId,
    public readonly configuredPath: string,
  ) {
    super(`Provider "${providerId}" CLI not found (configuredPath="${configuredPath}")`);
    this.name = "ProviderCliMissingError";
  }
}

/** Type guard for either availability-related error. */
export function isProviderAvailabilityError(
  err: unknown,
): err is ProviderDisabledError | ProviderCliMissingError {
  return err instanceof ProviderDisabledError || err instanceof ProviderCliMissingError;
}
