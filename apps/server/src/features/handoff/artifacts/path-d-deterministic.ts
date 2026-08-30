/**
 * Path D of the chat fork handoff ladder.
 *
 * The deterministic builder composes a thorough Markdown handoff document from
 * signals that already exist in the database — compact summary, fork-anchor
 * message body, recent tool activity, narration/reasoning highlights, and the
 * files changed across recent parent messages. It runs with no budget pressure
 * (candidate F delivers the budgeted off-band copy separately) so the
 * deterministic fallback is competitive with provider-generated summaries.
 *
 * The document is stateless and pure: every input is pre-gathered by the
 * pipeline and passed in via {@link PathDInput}. Empty sections are omitted so
 * the output adapts gracefully to whatever data the parent thread happened to
 * produce. The artifact keeps the canonical HandoffArtifact shape with
 * `ladderStep: "D"` and `generatedBy: "deterministic"`.
 */

import type { Thread, Message, ToolCallRecord, ThoughtSegmentRecord, ForkHistoryBudget } from "@mcode/contracts";
import { HANDOFF_MARKER } from "@mcode/contracts";
import type { HandoffArtifact, HandoffMeta, ForkAnchorRole, ProviderErrorClass } from "./handoff-types.js";

/** Input data required to produce a deterministic path-D handoff artifact. */
export interface PathDInput {
  parentThread: Thread;
  messagesUpToFork: Message[];
  forkedFromMessageId: string;
  forkAnchorRole: ForkAnchorRole;
  childThreadId: string;
  /** Why D ran instead of B/A. null when D was the only viable path. */
  reason: ProviderErrorClass | null;
  /** Parent thread's most recent compact summary, if any. Primary Goal source. */
  compactSummary?: string | null;
  /** Body of the fork-anchor message; rendered as fork-anchor context. */
  forkAnchorBody?: string | null;
  /** Recent tool-call records from the parent's latest assistant messages. */
  toolCallRecords?: ToolCallRecord[];
  /** Recent narration/reasoning segments from the parent's latest messages. */
  thoughtSegments?: ThoughtSegmentRecord[];
  /** De-duplicated files changed across recent parent messages. */
  filesChanged?: string[];
  /** Byte-budget metadata for the retained parent history window. */
  historyBudget?: ForkHistoryBudget;
}

/** Max narration highlights surfaced so reasoning context stays focused. */
const MAX_NARRATION_HIGHLIGHTS = 8;

function renderHistoryBudget(lines: string[], historyBudget?: ForkHistoryBudget): void {
  if (!historyBudget) return;
  const hasOmittedHistory = historyBudget.omittedBeforeCount > 0;
  const hasTruncation = historyBudget.truncatedMessages.length > 0;
  if (!hasOmittedHistory && !hasTruncation) return;

  lines.push("");
  lines.push("## History limit");
  lines.push("");
  if (hasOmittedHistory) {
    const suffix = historyBudget.omittedBeforeCount === 1 ? "" : "s";
    const verb = historyBudget.omittedBeforeCount === 1 ? "was" : "were";
    lines.push(`${historyBudget.omittedBeforeCount} earlier message${suffix} ${verb} elided because the fork history budget was reached.`);
  }
  if (hasTruncation) {
    const suffix = historyBudget.truncatedMessages.length === 1 ? "" : "s";
    const verb = historyBudget.truncatedMessages.length === 1 ? "was" : "were";
    lines.push(`${historyBudget.truncatedMessages.length} retained message${suffix} ${verb} truncated to keep the handoff within budget.`);
  }
}

/**
 * Render the structured Markdown body (everything above the metadata comment).
 * Each section is emitted only when its source data is present, so the document
 * shape is a deterministic function of which inputs were supplied.
 */
function renderBody(input: PathDInput): string {
  const lines = renderDocumentHeader(input.parentThread);
  renderHistoryBudget(lines, input.historyBudget);
  appendGoal(lines, input);
  appendFilesChanged(lines, input.filesChanged);
  appendToolActivity(lines, input.toolCallRecords);
  appendNarrationHighlights(lines, input.thoughtSegments);
  appendForkAnchor(lines, input);
  return lines.join("\n");
}

function renderDocumentHeader(parentThread: Thread): string[] {
  const modelInfo = parentThread.model ? ` ${parentThread.model}` : "";
  return [
    "# Handoff (deterministic)",
    "",
    `You are continuing work from a previous thread titled "${parentThread.title}".`,
    `The previous thread used${modelInfo} on branch ${parentThread.branch}.`,
  ];
}

function appendGoal(lines: string[], input: PathDInput): void {
  const compactSummary = input.compactSummary?.trim() || "";
  const forkAnchor = input.forkAnchorBody?.trim() || "";
  const lastAssistant = findLastAssistantText(input.messagesUpToFork);
  const goal = compactSummary || forkAnchor || lastAssistant;
  if (!goal) return;

  appendSection(lines, compactSummary ? "## Summary" : "## Recent context", [goal]);
}

function findLastAssistantText(messages: Message[]): string {
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  return lastAssistant?.content?.trim() ?? "";
}

function appendFilesChanged(lines: string[], filesChanged?: string[]): void {
  if (!filesChanged?.length) return;
  appendSection(lines, "## Recent files changed", filesChanged.map((file) => `- ${file}`));
}

function appendToolActivity(lines: string[], toolCallRecords?: ToolCallRecord[]): void {
  const tools = (toolCallRecords ?? []).filter((tool) => tool.tool_name);
  if (tools.length === 0) return;
  appendSection(lines, "## Recent tool activity", tools.map(formatToolActivity));
}

function formatToolActivity(tool: ToolCallRecord): string {
  const summary = tool.input_summary?.trim();
  const status = tool.status && tool.status !== "completed" ? ` (${tool.status})` : "";
  return `- ${tool.tool_name}${status}${summary ? `: ${summary}` : ""}`;
}

function appendNarrationHighlights(lines: string[], thoughtSegments?: ThoughtSegmentRecord[]): void {
  const highlights = (thoughtSegments ?? [])
    .filter((segment) => (segment.is_final_response ?? 0) === 0 && segment.text?.trim())
    .slice(0, MAX_NARRATION_HIGHLIGHTS);
  if (highlights.length === 0) return;
  appendSection(lines, "## Narration / reasoning highlights", highlights.map((segment) => `- ${segment.text.trim()}`));
}

function appendForkAnchor(lines: string[], input: PathDInput): void {
  const anchor = input.forkAnchorBody?.trim() || "";
  if (!anchor || !input.compactSummary?.trim()) return;
  appendSection(lines, `## Fork-anchor context (${input.forkAnchorRole} message)`, [anchor]);
}

function appendSection(lines: string[], heading: string, body: string[]): void {
  lines.push("", heading, "", ...body);
}

/**
 * Produce a HandoffArtifact by composing a thorough deterministic document from
 * the pre-gathered parent-thread signals in {@link PathDInput}.
 * Used when provider-generated handoffs are not available (quota, auth,
 * context-overflow, transient failure with no retry, or unsupported provider).
 */
export async function runPathDDeterministic(input: PathDInput): Promise<HandoffArtifact> {
  const { parentThread, forkedFromMessageId, forkAnchorRole, childThreadId, reason } = input;

  const body = renderBody(input);

  const metadata = {
    parentThreadId: parentThread.id,
    parentTitle: parentThread.title,
    forkedFromMessageId,
    sourceProvider: parentThread.provider,
    sourceModel: parentThread.model,
    sourceBranch: parentThread.branch,
    sourceWorktreePath: parentThread.worktree_path,
    sourceHead: null,
    recentFilesChanged: input.filesChanged ?? [],
    openTasks: [] as Array<{ content: string; status: string }>,
  };

  // Escape HTML comment terminators in the embedded JSON. User/project strings
  // (titles, branches, paths) can contain `-->`, which would close the comment
  // early. `\u003e` is JSON-safe: JSON.parse restores it to `>`, so the marker
  // parser still round-trips. Also neutralise `<!--` to avoid nested-comment
  // ambiguity in HTML renderers.
  const metadataJson = JSON.stringify(metadata, null, 2)
    .replace(/-->/g, "--\\u003e")
    .replace(/<!--/g, "\\u003c!--");
  const markdown = `${body}\n\n${HANDOFF_MARKER}\n${metadataJson}\n-->\n`;

  const meta: HandoffMeta = {
    schemaVersion: 1,
    parentThreadId: parentThread.id,
    forkedFromMessageId,
    forkAnchorRole,
    childThreadId,
    generatedBy: "deterministic",
    provider: parentThread.provider,
    ladderStep: "D",
    mode: "full",
    generatedAt: new Date().toISOString(),
    characterCount: markdown.length,
    parentSdkSessionId: parentThread.sdk_session_id ?? null,
    providerErrorOnGenerate: reason,
    regenerationHistory: [],
    attachments: [],
    ...(input.historyBudget && { historyBudget: input.historyBudget }),
  };
  return { markdown, meta };
}
