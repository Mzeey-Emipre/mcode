import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";

/** Frozen version 0 Terminal RPC definitions used by the legacy adapters. */
export const LegacyTerminalMethods = lazySchema(() => ({
  "terminal.create": {
    params: z.object({ threadId: z.string() }),
    result: z.object({ ptyId: z.string(), shell: z.string().max(64) }),
  },
  "terminal.write": {
    params: z.object({
      ptyId: z.string(),
      data: z.string().max(65_536),
    }),
    result: z.void(),
  },
  "terminal.resize": {
    params: z.object({
      ptyId: z.string(),
      cols: z.number().int().min(1).max(500),
      rows: z.number().int().min(1).max(500),
    }),
    result: z.void(),
  },
  "terminal.kill": {
    params: z.object({ ptyId: z.string() }),
    result: z.void(),
  },
  "terminal.pause": {
    params: z.object({ ptyId: z.string() }),
    result: z.void(),
  },
  "terminal.resume": {
    params: z.object({ ptyId: z.string() }),
    result: z.void(),
  },
  "terminal.checkpoint": {
    params: z.object({
      ptyId: z.string(),
      seq: z.number().int().min(-1),
      data: z.string().max(8 * 1024 * 1024),
    }),
    result: z.object({ accepted: z.boolean() }),
  },
  "terminal.killByThread": {
    params: z.object({ threadId: z.string() }),
    result: z.void(),
  },
  "terminal.reattach": {
    params: z.object({
      ptyId: z.string(),
      lastSeq: z.number().int().min(-1),
      cold: z.boolean().optional(),
    }),
    result: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("delta") }),
      z.object({
        mode: z.literal("checkpoint"),
        checkpoint: z.string(),
        checkpointThrough: z.number().int().min(-1),
      }),
      z.object({
        mode: z.literal("reset"),
        discardThrough: z.number().int().min(-1),
      }),
    ]),
  },
  "terminal.listActive": {
    params: z.object({}),
    result: z.array(z.object({ ptyId: z.string(), threadId: z.string() })),
  },
  "terminal.hasChildren": {
    params: z.object({ ptyId: z.string() }),
    result: z.object({ hasChildren: z.boolean() }),
  },
} as const));

/** Frozen version 0 Terminal push definitions used by the legacy adapters. */
export const LegacyTerminalChannels = lazySchema(() => ({
  "terminal.data": z.object({
    ptyId: z.string(),
    data: z.string(),
    seq: z.number().int().nonnegative().optional(),
  }),
  "terminal.exit": z.object({ ptyId: z.string(), code: z.number() }),
} as const));
