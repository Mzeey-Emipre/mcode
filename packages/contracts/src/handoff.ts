/**
 * Shared handoff contract used by both the server (handoff-builder) and
 * the client (handoff-utils) to produce and consume thread-branching context.
 *
 * Keeping the marker, shape, and parser in one place prevents the two sides
 * from silently drifting apart when the JSON structure evolves.
 */

/** Sentinel string that marks the start of an embedded handoff JSON block. */
export const HANDOFF_MARKER = "<!-- mcode-handoff";

/** Structured handoff metadata embedded in the HTML comment block. */
export interface HandoffMetadata {
  /** ID of the thread this child was branched from. */
  parentThreadId: string;
  /** Human-readable title of the parent thread. */
  parentTitle: string;
  /** Message ID in the parent thread at which the branch was taken. */
  forkedFromMessageId: string;
  /** AI provider used by the parent thread (e.g. "claude"). */
  sourceProvider: string;
  /** Model ID used by the parent thread, or null if not recorded. */
  sourceModel: string | null;
  /** Git branch the parent thread was running on. */
  sourceBranch: string;
  /** Absolute path to the parent thread's worktree, or null for direct-mode threads. */
  sourceWorktreePath: string | null;
  /** Git tree SHA at the fork point (ref_after of the last matching snapshot), or null. */
  sourceHead: string | null;
  /** Files changed up to and including the fork point. */
  recentFilesChanged: string[];
  /** Open tasks from the parent thread at time of branching (best-effort, may include post-fork tasks). */
  openTasks: Array<{ content: string; status: string }>;
}

/**
 * Extract and parse the HandoffMetadata JSON from a message content string.
 * Returns null if the content does not contain a valid handoff block.
 */
export function parseHandoffJson(content: string): HandoffMetadata | null {
  const startIdx = content.indexOf(HANDOFF_MARKER);
  if (startIdx === -1) return null;

  const jsonStart = startIdx + HANDOFF_MARKER.length;
  const endIdx = content.lastIndexOf("-->");
  if (endIdx === -1 || endIdx < jsonStart) return null;

  const jsonStr = content.slice(jsonStart, endIdx).trim();
  try {
    return JSON.parse(jsonStr) as HandoffMetadata;
  } catch {
    return null;
  }
}
