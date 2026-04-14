import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";
import { CopilotSubagentSourceSchema } from "../models/enums.js";

/**
 * Shared validation for Copilot agent names.
 * Applied consistently across discovery, send, and update schemas so a name
 * that passes discovery cannot be rejected on write.
 */
export const CopilotAgentNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w.-]+$/, "Agent name must contain only word chars, dots, and dashes");

/**
 * A Copilot sub-agent available for selection in the Composer.
 * Source distinguishes built-ins from user/project YAML-defined agents.
 */
export const CopilotSubagentSchema = lazySchema(() =>
  z.object({
    /** Unique identifier passed to the SDK (mode name or custom agent name). */
    name: CopilotAgentNameSchema,
    /** Human-readable label shown in the UI. */
    displayName: z.string(),
    /** Brief description of the agent's purpose. */
    description: z.string(),
    /** Where this agent was discovered from. */
    source: CopilotSubagentSourceSchema,
  }),
);

/** A Copilot sub-agent available for selection in the Composer. */
export type CopilotSubagent = z.infer<ReturnType<typeof CopilotSubagentSchema>>;
