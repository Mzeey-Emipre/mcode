import {
  TOOL_ICONS,
  TOOL_LABELS,
  TOOL_PHASE_LABELS,
  DEFAULT_ICON,
  resolveToolName,
  isShellTool,
} from "@/components/chat/tool-renderers/constants";
import type { ToolCall } from "@/transport/types";
import { extractToolInputDetail } from "./tool-detail";
import { NARRATIVE_TOOL_ROW, narrativeToolDetailClass } from "./narrative-layout";
import { CommandExecutionCard } from "./CommandExecutionCard";
import { BrowserActivitySummary, isBrowserNarrativeCall } from "./BrowserActivityRow";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface ActiveToolRowProps {
  toolCall: ToolCall;
}

/**
 * Renders the currently executing tool call. Spinning icon + label + detail.
 * No background tint - the spinning icon alone signals activity.
 */
export function ActiveToolRow({ toolCall }: ActiveToolRowProps) {
  if (isBrowserNarrativeCall(toolCall)) {
    return <BrowserActivitySummary calls={[toolCall]} active />;
  }

  if (isShellTool(toolCall.toolName)) {
    return <CommandExecutionCard toolCall={toolCall} isActive />;
  }

  if (toolCall.toolName === "Approval review") {
    return (
      <div className={`${NARRATIVE_TOOL_ROW} px-2 py-1 text-sm`}>
        <DEFAULT_ICON className="w-3.5 h-3.5 shrink-0 text-muted-foreground/60" />
        <span className="font-medium text-foreground shrink-0">Reviewing</span>
      </div>
    );
  }

  const canonicalName = resolveToolName(toolCall.toolName);
  const Icon = TOOL_ICONS[canonicalName] ?? DEFAULT_ICON;
  const label =
    TOOL_PHASE_LABELS[canonicalName] ??
    TOOL_LABELS[canonicalName] ??
    toolCall.toolName;
  const detail = extractToolInputDetail(toolCall);

  return (
    <div className={`${NARRATIVE_TOOL_ROW} px-2 py-1 text-sm`}>
      <Icon className="w-3.5 h-3.5 shrink-0 text-muted-foreground/60" />
      <span className="font-medium text-foreground shrink-0">{label}</span>
      <Tooltip>
        <TooltipTrigger
          render={<span className={narrativeToolDetailClass("sm")}>{detail}</span>}
        />
        <TooltipContent>{detail}</TooltipContent>
      </Tooltip>
    </div>
  );
}
