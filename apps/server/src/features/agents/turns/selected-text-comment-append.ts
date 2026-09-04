import {
  SelectedTextCommentsSchema,
  type SelectedTextComment,
} from "@mcode/contracts";

/** Opens the machine-readable selected-text comment data appended to a provider turn. */
export const MCODE_SELECTED_TEXT_COMMENTS_FENCE_OPEN = "<!-- mcode-selected-text-comments-v1 -->";

/** Closes the machine-readable selected-text comment data appended to a provider turn. */
export const MCODE_SELECTED_TEXT_COMMENTS_FENCE_CLOSE = "<!-- /mcode-selected-text-comments-v1 -->";

/**
 * Appends selected-text comments as schema-validated JSON data for a provider.
 *
 * Quotes and notes are user data. Escaping markup delimiters prevents either
 * field from closing the envelope or taking a structural role in the prompt.
 */
export function appendSelectedTextComments(
  content: string,
  selectedTextComments: readonly SelectedTextComment[] | undefined,
): string {
  if (!selectedTextComments || selectedTextComments.length === 0) return content;
  const comments = SelectedTextCommentsSchema().parse(selectedTextComments);
  const payload = escapeEnvelopeDelimiters(JSON.stringify({ schemaVersion: 1, comments }));
  const prefix = content.length === 0 ? "" : `${content}\n\n`;
  return `${prefix}${MCODE_SELECTED_TEXT_COMMENTS_FENCE_OPEN}\n${payload}\n${MCODE_SELECTED_TEXT_COMMENTS_FENCE_CLOSE}`;
}

function escapeEnvelopeDelimiters(json: string): string {
  return json
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}
