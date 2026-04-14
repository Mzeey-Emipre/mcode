import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";
import { CopilotSubagentSourceSchema } from "../models/enums.js";

/**
 * A Copilot sub-agent available for selection in the Composer.
 * Source distinguishes built-ins from user/project YAML-defined agents.
 */
export const CopilotSubagentSchema = lazySchema(() =>
  z.object({
    /** Unique identifier passed to the SDK (mode name or custom agent name). */
    name: z.string(),
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
