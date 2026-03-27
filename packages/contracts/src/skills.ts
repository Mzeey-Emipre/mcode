import { z } from "zod";

/** Metadata for a discovered skill. */
export const SkillInfoSchema = z.object({
  name: z.string(),
  description: z.string(),
});
/** Metadata for a discovered skill. */
export type SkillInfo = z.infer<typeof SkillInfoSchema>;
