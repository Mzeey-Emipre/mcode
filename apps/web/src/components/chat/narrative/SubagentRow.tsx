import { ChevronRight } from "lucide-react";
import { resolveSubagentDisplayName } from "@mcode/contracts";
import { SubagentIdentityGlyph } from "@/components/subagents/SubagentIdentityGlyph";
import {
  SubagentLifecycleStatus,
  type SubagentLifecycleTone,
} from "@/components/subagents/SubagentLifecycleStatus";
import { Button } from "@/components/ui/button";
import type { HookExecution, ToolCall } from "@/transport/types";
import { openSubagentDetail } from "@/lib/open-subagent-detail";
import { NARRATIVE_TOOL_ROW } from "./narrative-layout";

interface SubagentRowProps {
  toolCall: ToolCall;
  /** Direct children retained by the narrative builder but hidden from chat. */
  children: readonly ToolCall[];
  hooks: readonly HookExecution[];
  /** Full turn graph retained for detail projection. */
  allToolCalls?: readonly ToolCall[];
  /** Nested depth retained for the shared narrative contract. */
  depth?: number;
}

/** Renders one identity-only sub-agent lifecycle row in the chat narrative. */
export function SubagentRow({ toolCall }: SubagentRowProps) {
  const resolvedIdentity = resolveSubagentDisplayName(toolCall.toolInput);
  const identity = resolvedIdentity ?? "Subagent";
  const hasRunningOutput = !toolCall.isComplete
    && typeof toolCall.output === "string"
    && toolCall.output.trim().length > 0;
  const lifecycle: { label: string; tone: SubagentLifecycleTone } = toolCall.isCancelled
    ? { label: "Cancelled", tone: "muted" }
    : toolCall.isComplete && toolCall.isError
      ? { label: "Errored", tone: "error" }
      : !toolCall.isComplete
        ? {
            label: hasRunningOutput ? "Update received" : "Started",
            tone: "running",
          }
        : { label: "Finished", tone: "settled" };

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={() => openSubagentDetail(toolCall.id, toolCall.isComplete ? "finished" : "active")}
      className={`${NARRATIVE_TOOL_ROW} h-auto w-full justify-start gap-2 rounded-md px-2 py-1 text-left transition-colors duration-150 motion-reduce:transition-none hover:bg-muted/30`}
      aria-label={`Open ${identity} subagent details, ${lifecycle.label}`}
    >
      <SubagentIdentityGlyph
        identity={identity}
        hasExplicitIdentity={resolvedIdentity !== undefined}
        className="size-5"
        size={12}
      />
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground/85">
        {identity}
      </span>
      <SubagentLifecycleStatus label={lifecycle.label} tone={lifecycle.tone} />
      <ChevronRight size={13} className="shrink-0 text-muted-foreground/50" aria-hidden />
    </Button>
  );
}
