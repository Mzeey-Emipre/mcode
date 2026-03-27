import { z } from "zod";

/** Workspace schema matching the SQLite row shape. */
export const WorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  provider_config: z.record(z.unknown()),
  created_at: z.string(),
  updated_at: z.string(),
});
/** Workspace record from the database. */
export type Workspace = z.infer<typeof WorkspaceSchema>;
