import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";

/** Policy state for a provider model (read-only, set by org admins). */
export const ModelPolicyStateSchema = z.enum(["enabled", "disabled", "unconfigured"]);

/** Model metadata returned by a provider's listModels() call. */
export const ProviderModelInfoSchema = lazySchema(() =>
  z.object({
    /** Model identifier passed to createSession (e.g. "claude-sonnet-4.6"). */
    id: z.string(),
    /** Human-readable display name. */
    name: z.string(),
    /** Vendor grouping for UI sections (e.g. "OpenAI", "Anthropic"). */
    group: z.string().optional(),
    /** Max context window in tokens. */
    contextWindow: z.number().optional(),
    /** Whether the model supports image inputs. */
    supportsVision: z.boolean().optional(),
    /** Whether the model supports reasoning effort configuration. */
    supportsReasoning: z.boolean().optional(),
    /** Reasoning effort levels the model accepts. */
    supportedReasoningEfforts: z.array(z.enum(["low", "medium", "high", "xhigh"])).optional(),
    /** Default reasoning effort when none is specified. */
    defaultReasoningEffort: z.enum(["low", "medium", "high", "xhigh"]).optional(),
    /** Org/enterprise policy state. Absent when no policy is configured. */
    policy: z.object({ state: ModelPolicyStateSchema }).optional(),
    /** Billing rate multiplier relative to base plan (e.g. 1, 0.33, 3, 30). */
    multiplier: z.number().optional(),
  }),
);

/** TypeScript type inferred from ProviderModelInfoSchema. */
export type ProviderModelInfo = z.infer<ReturnType<typeof ProviderModelInfoSchema>>;
