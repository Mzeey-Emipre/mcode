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
  const {
    parentThread,
    messagesUpToFork,
    forkAnchorRole,
    compactSummary,
    forkAnchorBody,
    toolCallRecords,
    thoughtSegments,
    filesChanged,
    historyBudget,
  } = input;

  const lines: string[] = [];
  lines.push("# Handoff (deterministic)");
  lines.push("");
  lines.push(`You are continuing work from a previous thread titled "${parentThread.title}".`);
  const modelInfo = parentThread.model ? ` ${parentThread.model}` : "";
  lines.push(`The previous thread used${modelInfo} on branch ${parentThread.branch}.`);
  renderHistoryBudget(lines, historyBudget);

  // Goal / summary: prefer the model-generated compact summary, then the
  // fork-anchor body, then the last assistant message. No truncation.
  const lastAssistant = [...messagesUpToFork].reverse().find((m) => m.role === "assistant");
  const goal =
    (compactSummary && compactSummary.trim()) ||
    (forkAnchorBody && forkAnchorBody.trim()) ||
    (lastAssistant?.content?.trim() ?? "");
  if (goal) {
    const heading = compactSummary && compactSummary.trim() ? "## Summary" : "## Recent context";
    lines.push("");
    lines.push(heading);
    lines.push("");
    lines.push(goal);
  }

  if (filesChanged && filesChanged.length > 0) {
    lines.push("");
    lines.push("## Recent files changed");
    lines.push("");
    for (const f of filesChanged) {
      lines.push(`- ${f}`);
    }
  }

  const tools = (toolCallRecords ?? []).filter((t) => t.tool_name);
  if (tools.length > 0) {
    lines.push("");
    lines.push("## Recent tool activity");
    lines.push("");
    for (const t of tools) {
      const summary = t.input_summary?.trim();
      const status = t.status && t.status !== "completed" ? ` (${t.status})` : "";
      lines.push(`- ${t.tool_name}${status}${summary ? `: ${summary}` : ""}`);
    }
  }

  const highlights = (thoughtSegments ?? [])
    .filter((s) => (s.is_final_response ?? 0) === 0 && s.text?.trim())
    .slice(0, MAX_NARRATION_HIGHLIGHTS);
  if (highlights.length > 0) {
    lines.push("");
    lines.push("## Narration / reasoning highlights");
    lines.push("");
    for (const s of highlights) {
      lines.push(`- ${s.text.trim()}`);
    }
  }

  // Fork-anchor context: surface the anchor body distinctly when it wasn't
  // already used as the Goal source (i.e. a compact summary took that slot).
  const anchor = forkAnchorBody && forkAnchorBody.trim();
  const anchorUsedAsGoal = !(compactSummary && compactSummary.trim()) && !!anchor;
  if (anchor && !anchorUsedAsGoal) {
    lines.push("");
    lines.push(`## Fork-anchor context (${forkAnchorRole} message)`);
    lines.push("");
    lines.push(anchor);
  }

  return lines.join("\n");
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
