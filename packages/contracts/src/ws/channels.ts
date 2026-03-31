import { z } from "zod";
import { AgentEventSchema } from "../events/agent-event.js";
import { ThreadStatusSchema } from "../models/enums.js";
import { SettingsSchema } from "../models/settings.js";

/** All push channel definitions keyed by channel name. */
export const WS_CHANNELS = {
  "agent.event": AgentEventSchema,
  "terminal.data": z.object({ ptyId: z.string(), data: z.string() }),
  "terminal.exit": z.object({ ptyId: z.string(), code: z.number() }),
  "thread.status": z.object({
    threadId: z.string(),
    status: ThreadStatusSchema,
  }),
  "thread.prLinked": z.object({
    threadId: z.string(),
    prNumber: z.number(),
    prStatus: z.string(),
  }),
  "files.changed": z.object({
    workspaceId: z.string(),
    threadId: z.string().optional(),
  }),
  "settings.changed": SettingsSchema,
  "skills.changed": z.object({}),
  "branch.changed": z.object({ workspaceId: z.string(), branch: z.string() }),
  "turn.persisted": z.object({
    threadId: z.string(),
    messageId: z.string(),
    toolCallCount: z.number(),
    filesChanged: z.array(z.string()),
  }),
} as const;

/** Union of all push channel names. */
export type WsChannelName = keyof typeof WS_CHANNELS;
