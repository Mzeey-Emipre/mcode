import { z } from "zod";
import { AgentEventSchema } from "../events/agent-event.js";
import { ThreadStatusSchema } from "../models/enums.js";

/** All push channel definitions keyed by channel name. */
export const WS_CHANNELS = {
  "agent.event": AgentEventSchema,
  "terminal.data": z.object({ ptyId: z.string(), data: z.string() }),
  "terminal.exit": z.object({ ptyId: z.string(), code: z.number() }),
  "thread.status": z.object({
    threadId: z.string(),
    status: ThreadStatusSchema,
  }),
  "files.changed": z.object({
    workspaceId: z.string(),
    threadId: z.string().optional(),
  }),
  "skills.changed": z.object({}),
} as const;

/** Union of all push channel names. */
export type WsChannelName = keyof typeof WS_CHANNELS;
