/**
 * Generates handoff content for thread branching.
 * Produces two representations in one string:
 * 1. Prose for the provider (human-readable context)
 * 2. JSON metadata in an HTML comment for UI parsing
 */

import type { Thread, Message, TurnSnapshot, HandoffMetadata } from "@mcode/contracts";
import { HANDOFF_MARKER } from "@mcode/contracts";
export { HANDOFF_MARKER, parseHandoffJson } from "@mcode/contracts";
export type { HandoffMetadata } from "@mcode/contracts";

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
 * Rough char budget for the conversation replay injected into the provider.
 * Uses 15% of the model's known context window at ~4 chars/token,
 * leaving headroom for the new conversation.
 */
export function replayBudgetChars(modelId: string): number {
  // Claude models: 200K token context window
  if (modelId.startsWith("claude")) return 120_000; // 200_000 * 0.15 * 4
  // Conservative default for other models (~100K chars / ~25K tokens)
  return 100_000;
}

/**
 * Build a conversation transcript from a slice of parent messages.
 * Includes only user and assistant turns; skips system messages and tool noise.
 * Prioritizes recent messages when the transcript exceeds the char budget.
 * Prepends an omission notice when older turns are dropped.
 * If a compactSummary is provided, it replaces the generic omission notice with
 * the model-generated summary for higher fidelity context.
 */
export function buildConversationReplay(
  messages: Message[],
  maxChars: number,
  compactSummary?: string | null,
): string {
  const turns = messages.filter((m) => m.role === "user" || m.role === "assistant");
  const nonEmptyTurns = turns.filter((m) => m.content.trim() !== "");
  if (nonEmptyTurns.length === 0) return "";

  const formatted = nonEmptyTurns.map((m) => {
    const label = m.role === "user" ? "User" : "Assistant";
    return `${label}: ${m.content}`;
  });

  // Reserve space for the compact summary prefix so it doesn't blow the budget.
  // +2 accounts for the "\n\n" separator between the prefix and the first turn.
  const summaryReservation = compactSummary ? compactSummary.length + 2 : 0;
  const turnBudget = maxChars - summaryReservation;

  // If the summary alone exceeds the budget, fall back to truncating the summary.
  if (turnBudget <= 0) {
    return compactSummary ? compactSummary.slice(0, maxChars) : "";
  }

  // Walk backwards from the most recent turn, accumulating within budget.
  const result: string[] = [];
  let used = 0;
  for (let i = formatted.length - 1; i >= 0; i--) {
    const chunk = formatted[i];
    const cost = chunk.length + (result.length > 0 ? 2 : 0); // +2 for "\n\n" separator
    if (used + cost > turnBudget) break;
    result.unshift(chunk);
    used += cost;
  }

  if (result.length === 0) {
    // Truncate to turnBudget (not maxChars) so prepending the summary stays within budget.
    return formatted[formatted.length - 1].slice(0, turnBudget);
  }

  const omittedCount = nonEmptyTurns.length - result.length;
  if (omittedCount === 0) {
    // All turns fit — no prefix needed regardless of summary availability.
    return result.join("\n\n");
  }

  // Turns were dropped. Use compact summary if available; fall back to omission notice.
  const prefix = compactSummary
    ? `${compactSummary}\n\n`
    : `[${omittedCount} earlier message${omittedCount === 1 ? "" : "s"} omitted]\n\n`;

  return prefix + result.join("\n\n");
}

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
 * From a chronological list of turn snapshots (ordered ASC by created_at),
 * return the most recent one whose message_id is contained in the provided
 * set of forked message IDs.
 *
 * This is used to ensure that handoff context (files changed, HEAD ref)
 * reflects the state at the fork point, not the latest parent state.
 * Returns null when no snapshot falls within the fork range.
 *
 * @param snapshots - All snapshots for the parent thread, ASC by created_at.
 * @param forkedMessageIds - The complete set of message IDs up to and including
 *   the fork point (not just the fork message itself). Snapshots whose
 *   message_id is NOT in this set are post-fork and must be excluded.
 */
export function resolveForkSnapshot(
  snapshots: TurnSnapshot[],
  forkedMessageIds: Set<string>,
): TurnSnapshot | null {
  let result: TurnSnapshot | null = null;
  for (const s of snapshots) {
    if (forkedMessageIds.has(s.message_id)) {
      result = s;
    }
  }
  return result;
}

