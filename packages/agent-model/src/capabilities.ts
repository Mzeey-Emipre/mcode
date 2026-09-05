import { z } from "zod";
import { ProviderIdSchema } from "./identity.js";

/** Runtime capabilities that a provider can declare independently of its catalog entries. */
export const ProviderCapabilityNameSchema = z.enum([
  "build",
  "plan",
  "completion",
  "goals",
  "permissions",
  "usage",
  "session-eviction",
  "clean-fork",
  "orchestration",
  "browser-access",
  "thread-control",
  "provider-continuation",
  "child-cancellation",
  "turn-diff",
]);
/** Runtime capability that a provider can declare independently of its catalog entries. */
export type ProviderCapabilityName = z.infer<typeof ProviderCapabilityNameSchema>;

/** Explicit support state for one runtime capability. */
export const ProviderCapabilitySupportSchema = z.enum(["supported", "unsupported"]);
/** Explicit support state for one runtime capability. */
export type ProviderCapabilitySupport = z.infer<typeof ProviderCapabilitySupportSchema>;

/** One explicit runtime capability declaration. */
export const ProviderCapabilitySchema = z
  .object({
    name: ProviderCapabilityNameSchema,
    support: ProviderCapabilitySupportSchema,
  })
  .strict();
/** One explicit runtime capability declaration. */
export type ProviderCapability = z.infer<typeof ProviderCapabilitySchema>;

/** Canonical runtime-neutral provider descriptor. */
export const ProviderSchema = z
  .object({
    id: ProviderIdSchema,
    capabilities: z.array(ProviderCapabilitySchema).max(32),
  })
  .strict()
  .superRefine((provider, context) => {
    const names = new Set<ProviderCapabilityName>();
    provider.capabilities.forEach((capability, index) => {
      if (names.has(capability.name)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate capability declaration: ${capability.name}`,
          path: ["capabilities", index, "name"],
        });
      }
      names.add(capability.name);
    });
  });
/** Canonical runtime-neutral provider descriptor. */
export type Provider = z.infer<typeof ProviderSchema>;
