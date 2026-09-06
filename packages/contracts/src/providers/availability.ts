import { z } from "zod";
import { ProviderCapabilitySchema } from "../compat/agent-model.js";
import { lazySchema } from "../utils/lazySchema.js";

/** CLI verification status for a provider binary. */
export const CliStatusSchema = lazySchema(() =>
  z.enum(["found", "not_found", "unchecked"]),
);
/** CLI verification status for a provider binary. */
export type CliStatus = z.infer<ReturnType<typeof CliStatusSchema>>;

/** CLI resolution detail attached to a ProviderAvailability record. */
export const ProviderCliInfoSchema = lazySchema(() =>
  z.object({
    status: CliStatusSchema(),
    /** Path that `which` or `fs.stat` resolved, or null when not_found/unchecked. */
    resolvedPath: z.string().nullable(),
    /** The configured path from settings.provider.cli[id]. Empty string means "auto via PATH". */
    configuredPath: z.string(),
  }),
);

/** Runtime availability snapshot for a single provider, broadcast to the frontend. */
export const ProviderAvailabilitySchema = lazySchema(() =>
  z.object({
    id: z.enum(["claude", "codex", "gemini", "copilot", "cursor", "opencode"]),
    enabled: z.boolean(),
    /** True when a runtime adapter is registered for this provider. */
    hasAdapter: z.boolean(),
    beta: z.boolean(),
    comingSoon: z.boolean(),
    /** Static capabilities declared by the registered adapter. */
    capabilities: z.array(ProviderCapabilitySchema).max(32),
    cli: ProviderCliInfoSchema(),
  }),
);

/** Runtime availability snapshot for a single provider. */
export type ProviderAvailability = z.infer<ReturnType<typeof ProviderAvailabilitySchema>>;
