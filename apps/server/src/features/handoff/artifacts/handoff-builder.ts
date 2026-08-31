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
import { getModelContextWindow } from "@mcode/shared/model-context";

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
 * Uses 15% of the model's *maximum* context window at ~4 chars/token, leaving
 * headroom for the new conversation. We pass `"1m"` here so 1M-capable models
 * get the larger budget — the per-thread context window is selected at send
 * time and may differ, but the replay should fit either tier comfortably.
 * Falls back to a conservative 100K chars (~25K tokens) when the model is
 * unknown.
 */
export function replayBudgetChars(modelId: string): number {
  const contextWindow = getModelContextWindow(modelId, "1m");
  if (contextWindow !== undefined) {
    // 15% of the context window, at ~4 chars/token.
    return Math.floor(contextWindow * 0.15 * 4);
  }
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
  const formatted = messages
    .filter(isConversationTurn)
    .filter(hasContent)
    .map(formatConversationTurn);
  return buildReplayFromFormattedTurns(formatted, maxChars, compactSummary);
}

function isConversationTurn(message: Message): boolean {
  return message.role === "user" || message.role === "assistant";
}

function hasContent(message: Message): boolean {
  return message.content.trim() !== "";
}

function formatConversationTurn(message: Message): string {
  const label = message.role === "user" ? "User" : "Assistant";
  return `${label}: ${message.content}`;
}

function buildReplayFromFormattedTurns(
  formatted: string[],
  maxChars: number,
  compactSummary?: string | null,
): string {
  if (formatted.length === 0) return "";
  const turnBudget = maxChars - summaryReservation(compactSummary);
  return buildReplayWithinBudget(formatted, maxChars, turnBudget, compactSummary);
}

function summaryReservation(compactSummary?: string | null): number {
  return compactSummary ? compactSummary.length + 2 : 0;
}

function buildReplayWithinBudget(
  formatted: string[],
  maxChars: number,
  turnBudget: number,
  compactSummary?: string | null,
): string {
  if (turnBudget <= 0) return compactSummary ? compactSummary.slice(0, maxChars) : "";
  return buildReplayFromRecentTurns(formatted, turnBudget, compactSummary);
}

function buildReplayFromRecentTurns(
  formatted: string[],
  turnBudget: number,
  compactSummary?: string | null,
): string {
  const result = selectRecentTurns(formatted, turnBudget);
  if (result.length === 0) return formatted.at(-1)!.slice(0, turnBudget);

  const omittedCount = formatted.length - result.length;
  if (omittedCount === 0) return result.join("\n\n");
  return omittedPrefix(compactSummary, omittedCount) + result.join("\n\n");
}

function selectRecentTurns(formatted: string[], turnBudget: number): string[] {
  const result: string[] = [];
  let used = 0;
  for (let index = formatted.length - 1; index >= 0; index--) {
    const chunk = formatted[index];
    const cost = chunk.length + (result.length > 0 ? 2 : 0);
    if (used + cost > turnBudget) break;
    result.unshift(chunk);
    used += cost;
  }
  return result;
}

function omittedPrefix(compactSummary: string | null | undefined, omittedCount: number): string {
  return compactSummary
    ? `${compactSummary}\n\n`
    : `[${omittedCount} earlier message${omittedCount === 1 ? "" : "s"} omitted]\n\n`;
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

