import { useState } from "react";
import { AnimatedCollapsible } from "@/components/ui/animated-collapsible";
import {
  TOOL_ICONS,
  TOOL_LABELS,
  DEFAULT_ICON,
  buildToolSummaryText,
  resolveToolName,
  isShellTool,
} from "@/components/chat/tool-renderers/constants";
import type { ToolCall } from "@/transport/types";
import type { ToolGroup } from "./types";
import { extractToolInputDetail } from "./tool-detail";
import { NARRATIVE_TOOL_ROW, narrativeToolDetailClass } from "./narrative-layout";
import { ToolOutputTruncationNotice } from "./ToolOutputTruncationNotice";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ShellToolCallRow } from "./ShellToolCallRow";
import {
  BrowserActivitySummary,
  isBrowserNarrativeCall,
} from "./BrowserActivityRow";
import { NarrativeSummaryLine } from "./NarrativeSummaryLine";

interface ToolSummaryLineProps {
  /** The group of consecutive tool calls to summarize. */
  group: ToolGroup;
  /** Whether any call in the group errored. */
  hasError: boolean;
  /** Whether any call in the group was cancelled. */
  hasCancelled: boolean;
}

/**
 * Returns the worst-status badge variant for a single tool call.
 * Errored calls take priority over cancelled (incomplete + error) calls.
 */
function getCallStatus(tc: ToolCall): "completed" | "errored" | "cancelled" {
  if (tc.isError) return "errored";
  if (tc.isCancelled || !tc.isComplete) return "cancelled";
  return "completed";
}

interface StatusBadgeProps {
  /** The status variant to render. */
  status: "completed" | "errored" | "cancelled";
}

/**
 * Small monospace badge showing the outcome of a tool call.
 */
function StatusBadge({ status }: StatusBadgeProps) {
  const styles: Record<string, string> = {
    completed:
      "bg-[var(--diff-add)]/15 text-[var(--diff-add)]",
    errored:
      "bg-[var(--diff-remove)]/15 text-[var(--diff-remove)]",
    cancelled:
      "bg-muted-foreground/18 text-muted-foreground",
  };
  return (
    <span
      className={`rounded-sm px-1.5 py-px font-mono text-xs font-medium ${styles[status]}`}
    >
      {status}
    </span>
  );
}

function ApprovalReviewDetailRow({ toolCall }: { toolCall: ToolCall }) {
  const detail = toolCall.isComplete ? toolCall.output || "Review complete" : "Reviewing";
  const status = getCallStatus(toolCall);

  return (
    <li className="flex min-w-0 max-w-full flex-col gap-1 py-1">
      <div className={`${NARRATIVE_TOOL_ROW} text-sm`}>
        <DEFAULT_ICON className="size-3.5 shrink-0 text-muted-foreground/75" />
        <span className={narrativeToolDetailClass("md")}>{detail}</span>
        {status !== "completed" ? <StatusBadge status={status} /> : null}
      </div>
    </li>
  );
}

function ToolCallDetailRow({ toolCall: tc }: { toolCall: ToolCall }) {
  if (tc.toolName === "Approval review") return <ApprovalReviewDetailRow toolCall={tc} />;
  if (isShellTool(tc.toolName)) return (
    <li className="min-w-0 max-w-full">
      <ShellToolCallRow toolCall={tc} />
    </li>
  );

  const canonicalName = resolveToolName(tc.toolName);
  const Icon = TOOL_ICONS[canonicalName] ?? DEFAULT_ICON;
  const label = TOOL_LABELS[canonicalName] ?? tc.toolName;
  const detail = extractToolInputDetail(tc);
  const status = getCallStatus(tc);

  return (
    <li className="flex min-w-0 max-w-full flex-col gap-1 py-1">
      <div className={`${NARRATIVE_TOOL_ROW} text-sm`}>
        <Icon className="size-3.5 shrink-0 text-muted-foreground/75" />
        <span className="shrink-0 font-medium text-foreground/65">{label}</span>
        <Tooltip>
          <TooltipTrigger
            render={<span className={narrativeToolDetailClass("md")}>{detail}</span>}
          />
          <TooltipContent>{detail}</TooltipContent>
        </Tooltip>
        {status !== "completed" ? <StatusBadge status={status} /> : null}
      </div>
      {tc.isError && tc.output ? (
        <div className="flex min-w-0 max-w-full flex-col gap-1">
          <ToolOutputTruncationNotice toolCall={tc} />
          <pre className="max-h-40 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded bg-[var(--diff-remove)]/10 px-2 py-1 font-mono text-sm text-[var(--diff-remove)]">
            {tc.output}
          </pre>
        </div>
      ) : null}
    </li>
  );
}

/**
 * Renders a compact one-liner summarizing a group of consecutive tool calls.
 *
 * The collapsed state shows a leading icon, summary text (e.g. "Read 3 files,
 * 1 search"), an optional worst-status badge, and a chevron. Clicking the row
 * expands an indented list of individual tool calls with per-call icons,
 * labels, detail text, status badges, and optional inline output blocks.
 */
export function ToolSummaryLine({
  group,
  hasError,
  hasCancelled,
}: ToolSummaryLineProps) {
  const [open, setOpen] = useState(false);
  const hasBrowserActivity = group.calls.some(isBrowserNarrativeCall);

  if (hasBrowserActivity) {
    return (
      <BrowserActivitySummary
        calls={group.calls}
        renderOtherCall={(call) => <ToolCallDetailRow key={call.id} toolCall={call} />}
      />
    );
  }

  const firstCall = group.calls[0];
  const LeadingIcon = firstCall
    ? (TOOL_ICONS[resolveToolName(firstCall.toolName)] ?? DEFAULT_ICON)
    : DEFAULT_ICON;

  const summaryText = buildToolSummaryText(group.calls);

  const worstBadge: "errored" | "cancelled" | null = hasError
    ? "errored"
    : hasCancelled
    ? "cancelled"
    : null;

  return (
    <div
      className="min-w-0 max-w-full rounded-md"
      data-first-tool-call-id={group.calls[0]?.id}
      data-last-tool-call-id={group.calls[group.calls.length - 1]?.id}
    >
      {/* Summary row */}
      <NarrativeSummaryLine
        open={open}
        onToggle={() => setOpen((prev) => !prev)}
        icon={<LeadingIcon className="h-3 w-3 shrink-0 text-muted-foreground/55" />}
        badge={worstBadge ? <StatusBadge status={worstBadge} /> : undefined}
      >
        <span className="min-w-0 flex-1 truncate font-medium text-foreground/75">
          {summaryText}
        </span>
      </NarrativeSummaryLine>

      {/* Expanded detail list */}
      {open ? (
        <AnimatedCollapsible open>
          <ul className="mt-1 min-w-0 max-w-full space-y-1 pb-2 pl-6">
            {group.calls.map((tc) => <ToolCallDetailRow key={tc.id} toolCall={tc} />)}
          </ul>
        </AnimatedCollapsible>
      ) : null}
    </div>
  );
}
