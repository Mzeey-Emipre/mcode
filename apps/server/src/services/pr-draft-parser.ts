/**
 * Extracts and validates a structured PR draft from an AI text response.
 */
import { z } from "zod";
import type { PrDraft } from "@mcode/contracts";

const PrDraftResponseSchema = z.object({
  title: z.string().min(1, "title must be a non-empty string"),
  body: z.string().min(1, "body must be a non-empty string"),
});

/**
 * Extract the first JSON object from an AI response string and validate it
 * against the PR draft schema.
 * @throws {Error} when no JSON object is found, when the JSON cannot be parsed,
 *   or when required fields are missing or the wrong type.
 */
export function parseCompletionDraft(text: string): PrDraft {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("AI response contained no valid JSON");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    throw new Error("AI response JSON could not be parsed");
  }

  const result = PrDraftResponseSchema.safeParse(parsed);
  if (!result.success) {
    const fields = result.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`AI response JSON failed validation — invalid fields: ${fields}`);
  }

  return result.data;
}
