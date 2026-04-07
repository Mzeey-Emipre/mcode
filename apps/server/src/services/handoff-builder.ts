/**
 * Generates handoff content for thread branching.
 * Produces two representations in one string:
 * 1. Prose for the provider (human-readable context)
 * 2. JSON metadata in an HTML comment for UI parsing
 */

import type { Thread } from "@mcode/contracts";

/** Marker used to detect handoff system messages in both server and client. */
export const HANDOFF_MARKER = "<!-- mcode-handoff";

/** Structured handoff metadata embedded in the HTML comment. */
export interface HandoffMetadata {
  parentThreadId: string;
  parentTitle: string;
  forkedFromMessageId: string;
  sourceProvider: string;
  sourceModel: string | null;
  sourceBranch: string;
  sourceWorktreePath: string | null;
  sourceHead: string | null;
  recentFilesChanged: string[];
  openTasks: Array<{ content: string; status: string }>;
}

/** Input for building handoff content. */
export interface HandoffInput {
  parentThread: Thread;
  forkMessageId: string;
  lastAssistantText: string | null;
  recentFilesChanged: string[];
  openTasks: Array<{ content: string; status: string }>;
  sourceHead: string | null;
}

const MAX_ASSISTANT_TEXT = 2000;

/**
 * Build the full handoff system message content.
 * Contains provider-facing prose followed by a hidden JSON block.
 */
export function buildHandoffContent(input: HandoffInput): string {
  const { parentThread, forkMessageId, lastAssistantText, recentFilesChanged, openTasks, sourceHead } = input;

  const lines: string[] = [];
  lines.push(`You are continuing work from a previous thread titled "${parentThread.title}".`);

  const modelInfo = parentThread.model ? ` ${parentThread.model}` : "";
  lines.push(`The previous thread used${modelInfo} on branch ${parentThread.branch}.`);

  if (lastAssistantText) {
    const truncated =
      lastAssistantText.length > MAX_ASSISTANT_TEXT
        ? lastAssistantText.slice(0, MAX_ASSISTANT_TEXT) + "..."
        : lastAssistantText;
    lines.push("");
    lines.push("Recent context:");
    lines.push(truncated);
  }

  if (recentFilesChanged.length > 0) {
    lines.push("");
    lines.push("Recent files changed:");
    for (const f of recentFilesChanged) {
      lines.push(`- ${f}`);
    }
  }

  if (openTasks.length > 0) {
    lines.push("");
    lines.push("Open tasks:");
    for (const t of openTasks) {
      const marker = t.status === "completed" ? "[x]" : "[ ]";
      lines.push(`- ${marker} ${t.content}`);
    }
  }

  const metadata: HandoffMetadata = {
    parentThreadId: parentThread.id,
    parentTitle: parentThread.title,
    forkedFromMessageId: forkMessageId,
    sourceProvider: parentThread.provider,
    sourceModel: parentThread.model,
    sourceBranch: parentThread.branch,
    sourceWorktreePath: parentThread.worktree_path,
    sourceHead: sourceHead,
    recentFilesChanged,
    openTasks,
  };

  lines.push("");
  lines.push(`${HANDOFF_MARKER}`);
  lines.push(JSON.stringify(metadata, null, 2));
  lines.push("-->");

  return lines.join("\n");
}

/**
 * Extract and parse the HandoffMetadata JSON from a message content string.
 * Returns null if the content does not contain a valid handoff block.
 */
export function parseHandoffJson(content: string): HandoffMetadata | null {
  const startIdx = content.indexOf(HANDOFF_MARKER);
  if (startIdx === -1) return null;

  const jsonStart = startIdx + HANDOFF_MARKER.length;
  const endIdx = content.indexOf("-->", jsonStart);
  if (endIdx === -1) return null;

  const jsonStr = content.slice(jsonStart, endIdx).trim();
  try {
    return JSON.parse(jsonStr) as HandoffMetadata;
  } catch {
    return null;
  }
}
