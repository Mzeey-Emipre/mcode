import { useState } from "react";
import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { AnimatedCollapsible } from "@/components/ui/animated-collapsible";
import {
  TOOL_ICONS,
  TOOL_LABELS,
  DEFAULT_ICON,
  buildToolSummaryText,
  resolveToolName,
  isShellTool,
} from "../tool-renderers/constants";
import type { ToolCall } from "@/transport/types";
import type { ToolGroup } from "./types";
import { extractToolInputDetail } from "./tool-detail";
import { NARRATIVE_TOOL_ROW, narrativeToolDetailClass } from "./narrative-layout";
import { ToolOutputTruncationNotice } from "./ToolOutputTruncationNotice";
import { CommandExecutionCard } from "./CommandExecutionCard";

interface ToolSummaryLineProps {
  /** The group of consecutive tool calls to summarize. */
  group: ToolGroup;
  /** Whether any call in the group errored. */
  hasError: boolean;
  /** Whether any call in the group was cancelled. */
  hasCancelled: boolean;
}

interface NarrativeSummaryLineProps {
  /** Whether the row is currently expanded. */
  open: boolean;
  /** Called when the row is clicked. */
  onToggle: () => void;
  /** Leading status or type icon. */
  icon: ReactNode;
  /** Primary summary text. */
  children: ReactNode;
  /** Optional status badge rendered before the chevron. */
  badge?: ReactNode;
  /** Whether the row can be expanded. */
  expandable?: boolean;
  /** Whether clicking the row is disabled. */
  disabled?: boolean;
}

/** Shared compact narrative summary row used by tool and hook groups. */
export function NarrativeSummaryLine({
  open,
  onToggle,
  icon,
  children,
  badge,
  expandable = true,
  disabled = false,
}: NarrativeSummaryLineProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      className={`${NARRATIVE_TOOL_ROW} w-full px-2 py-1 text-left rounded-md transition-colors duration-100 text-sm ${
        disabled ? "cursor-default" : "hover:bg-muted/30"
      }`}
      aria-expanded={expandable ? open : undefined}
    >
      {icon}
      {children}
      {badge}
      {expandable && (
        <ChevronRight
          className={`h-3 w-3 text-muted-foreground/30 shrink-0 transition-transform duration-150 ${
            open ? "rotate-90" : ""
          }`}
        />
      )}
    </button>
  );
}

/**
 * Returns the worst-status badge variant for a single tool call.
 * Errored calls take priority over cancelled (incomplete + error) calls.
 */
function getCallStatus(tc: ToolCall): "completed" | "errored" | "cancelled" {
  if (tc.isError) return "errored";
  if (!tc.isComplete) return "cancelled";
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
      className={`font-mono text-xs font-medium px-1.5 py-px rounded-sm ${styles[status]}`}
    >
      {status}
    </span>
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

  if (
    group.calls.length > 0 &&
    group.calls.every((call) => isShellTool(call.toolName))
  ) {
    return (
      <div className="flex min-w-0 max-w-full flex-col gap-1 py-0.5">
        {group.calls.map((toolCall) => (
          <CommandExecutionCard key={toolCall.id} toolCall={toolCall} />
        ))}
      </div>
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
    <div className="min-w-0 max-w-full rounded-md">
      {/* Summary row */}
      <NarrativeSummaryLine
        open={open}
        onToggle={() => setOpen((prev) => !prev)}
        icon={<LeadingIcon className="w-3 h-3 shrink-0 text-muted-foreground/40" />}
        badge={worstBadge ? <StatusBadge status={worstBadge} /> : undefined}
      >
        <span className="text-muted-foreground/60 flex-1 min-w-0 truncate">
          {summaryText}
        </span>
      </NarrativeSummaryLine>

      {/* Expanded detail list */}
      <AnimatedCollapsible open={open}>
        <ul className="min-w-0 max-w-full pl-6 mt-0.5 space-y-0.5 pb-1">
          {group.calls.map((tc) => {
            const canonicalName = resolveToolName(tc.toolName);
            const Icon = TOOL_ICONS[canonicalName] ?? DEFAULT_ICON;
            const label = TOOL_LABELS[canonicalName] ?? tc.toolName;
            const detail = extractToolInputDetail(tc);
            const status = getCallStatus(tc);

            if (isShellTool(tc.toolName)) {
              return (
                <li key={tc.id} className="min-w-0 max-w-full py-0.5">
                  <CommandExecutionCard toolCall={tc} />
                </li>
              );
            }

            return (
              <li key={tc.id} className="flex min-w-0 max-w-full flex-col gap-0.5">
                {/* Row: icon + label + detail + badge */}
                <div className={`${NARRATIVE_TOOL_ROW} text-sm`}>
                  <Icon className="w-[14px] h-[14px] text-muted-foreground/75 shrink-0" />
                  <span className="text-foreground/65 font-medium shrink-0">
                    {label}
                  </span>
                  <span className={narrativeToolDetailClass("md")} title={detail}>
                    {detail}
                  </span>
                  {status !== "completed" && <StatusBadge status={status} />}
                </div>

                {/* Inline content blocks */}
                {tc.isError && tc.output && (
                  <div className="flex min-w-0 max-w-full flex-col gap-1">
                    <ToolOutputTruncationNotice toolCall={tc} />
                    <pre className="max-w-full text-sm font-mono rounded px-2 py-1 bg-[var(--diff-remove)]/10 text-[var(--diff-remove)] overflow-x-auto whitespace-pre-wrap break-words max-h-40">
                      {tc.output}
                    </pre>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </AnimatedCollapsible>
    </div>
  );
}
