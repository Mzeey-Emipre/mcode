/**
 * Core pattern matching a file path after the @ trigger.
 * Must contain at least one / or . to distinguish from @mentions.
 */
export const FILE_PATH_PATTERN = String.raw`[\w./-][\w./-]*(?:[/.][\w./-]+)+`;

/** Extract file path references from message text.
 *
 * A valid @path:
 * - Starts with @ preceded by whitespace or start-of-string
 * - Contains path characters: letters, digits, /, -, _, .
 * - Must contain at least one / or . (to distinguish from @mentions)
 * - Stops at whitespace or end-of-string
 */
export function extractFileRefs(text: string): string[] {
  const pattern = new RegExp(String.raw`(?:^|(?<=\s))@(${FILE_PATH_PATTERN})`, "g");
  return [...text.matchAll(pattern)].map((m) => m[1]);
}

export interface FileContent {
  path: string;
  content: string;
}

/** Build the final message with file content injected after a separator. */
export function buildInjectedMessage(
  text: string,
  files: FileContent[],
): string {
  if (files.length === 0) return text;

  const fileBlocks = files
    .map((f) => `<file path="${f.path}">\n${f.content}\n</file>`)
    .join("\n");

  return `${text}\n\n---\n${fileBlocks}`;
}
