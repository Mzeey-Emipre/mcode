import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";
import { TerminalV1BackendCapabilitiesSchema } from "./terminal.js";

/** Reports the Terminal backend and protocol features selected for one server boot. */
export const TerminalBackendCapabilitiesSchema = lazySchema(() =>
  z.union([
    z.object({
      contractVersion: z.literal(0),
      backend: z.literal("legacy"),
      publicFrameVersion: z.literal(0),
      recovery: z
        .object({
          replay: z.literal(true),
          checkpoint: z.literal(true),
          gap: z.literal(true),
        })
        .strict(),
      releaseTest: z
        .object({ hostPid: z.number().int().min(1).max(4_294_967_295) })
        .strict()
        .optional(),
    })
    .strict(),
    TerminalV1BackendCapabilitiesSchema(),
  ]),
);

/** Terminal backend capabilities selected for one server boot. */
export type TerminalBackendCapabilities = z.infer<
  ReturnType<typeof TerminalBackendCapabilitiesSchema>
>;
