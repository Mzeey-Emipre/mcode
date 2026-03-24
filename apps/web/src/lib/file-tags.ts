/**
 * Utilities for @ file tagging: pattern matching, content injection, and display stripping.
 *
 * Used by the Composer (trigger detection, content injection on send),
 * TextOverlay (highlight rendering), and MessageBubble (stripping injected blocks).
 */

/**
 * Core pattern matching a file path after the @ trigger.
 * Must contain at least one / or . to distinguish from @mentions.
 */
export const FILE_PATH_PATTERN = String.raw`[\w./-][\w./-]*(?:[/.][\w./-]+)+`;

/**
 * Pre-compiled regex for extracting @path references (path only, no @).
 * Uses lookbehind to require whitespace or start-of-string before @.
 */
const EXTRACT_REFS_RE = new RegExp(
  String.raw`(?:^|(?<=\s))@(${FILE_PATH_PATTERN})`,
  "g",
);

/**
 * Pre-compiled regex for matching @path tokens including the @ prefix.
 * Used by TextOverlay to locate highlight positions.
 */
export const HIGHLIGHT_RE = new RegExp(
  String.raw`(?:^|(?<=\s))(@${FILE_PATH_PATTERN})`,
  "g",
);

/**
 * Combined regex matching both @file/path and /command tokens in a single pass.
 * Group 1: @file/path token (including the @).
 * Group 2: /command-name token (allows word chars, colons for namespaced
 *          commands like `superpowers:project-manager`, and hyphens).
 * Used by TextOverlay for unified multi-token highlighting.
 */
export const COMBINED_TOKEN_RE = new RegExp(
  String.raw`(?:^|(?<=\s))(?:(@${FILE_PATH_PATTERN})|(\/[\w:][\w:-]*))`,
  "g",
);

/** Sentinel separating user text from injected file blocks. */
const FILE_INJECTION_SEPARATOR = "\n\n---\n";

/** Extract file path references from message text.
 *
 * A valid @path:
 * - Starts with @ preceded by whitespace or start-of-string
 * - Contains path characters: letters, digits, /, -, _, .
 * - Must contain at least one / or . (to distinguish from @mentions)
 * - Stops at whitespace or end-of-string
 */
export function extractFileRefs(text: string): string[] {
  EXTRACT_REFS_RE.lastIndex = 0;
  return [...text.matchAll(EXTRACT_REFS_RE)].map((m) => m[1]);
}

/** Represents a file's path and content for injection. */
export interface FileContent {
  path: string;
  content: string;
}

/**
 * Strip injected file blocks from a message for display purposes.
 * Returns only the user's original text, without the appended file content.
 */
export function stripInjectedFiles(text: string): string {
  const sentinel = `${FILE_INJECTION_SEPARATOR}<file path=`;
  const idx = text.indexOf(sentinel);
  return idx === -1 ? text : text.slice(0, idx);
}

/**
 * Build the final message with file content injected after a separator.
 * The separator + file blocks are appended so the AI receives the full content
 * while `stripInjectedFiles` can remove them for display.
 */
export function buildInjectedMessage(
  text: string,
  files: FileContent[],
): string {
  if (files.length === 0) return text;

  const fileBlocks = files
    .map((f) => {
      const escaped = f.content.replace(/<\/file>/gi, "<\\/file>");
      return `<file path="${f.path}">\n${escaped}\n</file>`;
    })
    .join("\n");

  return `${text}${FILE_INJECTION_SEPARATOR}${fileBlocks}`;
}
