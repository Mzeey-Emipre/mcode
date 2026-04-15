import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";

/** The set of decisions a user can make on a permission request. */
export const PermissionDecisionSchema = z.enum([
  "allow",
  "allow-session",
  "deny",
  "cancelled",
]);
/** A user's decision on a pending tool permission request. */
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

/** A pending permission request pushed to the frontend. */
export const PermissionRequestSchema = lazySchema(() => z.object({
  requestId: z.string(),
  threadId: z.string(),
  toolName: z.string(),
  /** Raw tool input arguments; shape varies by tool. */
  input: z.unknown(),
  title: z.string().optional(),
}));
/** A pending tool permission request awaiting user decision. */
export type PermissionRequest = z.infer<ReturnType<typeof PermissionRequestSchema>>;
