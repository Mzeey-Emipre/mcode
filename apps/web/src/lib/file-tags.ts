/**
 * Match @path references in message text.
 *
 * A valid @path:
 * - Starts with @ preceded by whitespace or start-of-string
 * - Contains path characters: letters, digits, /, -, _, .
 * - Must contain at least one / or . (to distinguish from @mentions)
 * - Stops at whitespace or end-of-string
 */
const FILE_REF_PATTERN = /(?:^|(?<=\s))@([\w./-][\w./-]*(?:[/.][\w./-]+)+)/g;

/** Extract file path references from message text. */
export function extractFileRefs(text: string): string[] {
  const refs: string[] = [];
  for (const match of text.matchAll(FILE_REF_PATTERN)) {
    refs.push(match[1]);
  }
  return refs;
}

interface FileContent {
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
