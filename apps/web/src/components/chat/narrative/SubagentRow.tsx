import { ChevronRight } from "lucide-react";
import { resolveSubagentDisplayName } from "@mcode/contracts";
import { SubagentIdentityGlyph } from "@/components/subagents/SubagentIdentityGlyph";
import { Button } from "@/components/ui/button";
import type { HookExecution, ToolCall } from "@/transport/types";
import { openSubagentDetail } from "@/lib/open-subagent-detail";
import { NARRATIVE_TOOL_ROW } from "./narrative-layout";
import type { SubagentLifecycle } from "./subagent-lifecycle";

interface SubagentRowProps {
  toolCall: ToolCall;
  lifecycle: SubagentLifecycle;
  /** Direct children retained by the narrative builder but hidden from chat. */
  children: readonly ToolCall[];
  hooks: readonly HookExecution[];
  /** Full turn graph retained for detail projection. */
  allToolCalls?: readonly ToolCall[];
  /** Nested depth retained for the shared narrative contract. */
  depth?: number;
}

/** Renders one identity-only sub-agent lifecycle row in the chat narrative. */
export function SubagentRow({ toolCall, lifecycle }: SubagentRowProps) {
  const resolvedIdentity = resolveSubagentDisplayName(toolCall.toolInput);
  const identity = resolvedIdentity ?? "Subagent";
  const lifecycleLabel = lifecycle === "started" ? "started working" : lifecycle;

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={() => openSubagentDetail(toolCall.id, toolCall.isComplete ? "finished" : "active")}
      className={`${NARRATIVE_TOOL_ROW} h-auto w-full justify-start gap-2 rounded-sm px-1 py-1 text-left transition-colors duration-150 motion-reduce:transition-none hover:bg-muted/30`}
      aria-label={`Open ${identity} subagent details, ${lifecycleLabel}`}
    >
      <SubagentIdentityGlyph
        identity={identity}
        hasExplicitIdentity={resolvedIdentity !== undefined}
        className="size-5"
        size={12}
      />
      <span className="min-w-0 truncate text-xs font-medium text-foreground/85">
        {identity}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {lifecycleLabel}
      </span>
      <ChevronRight size={12} className="shrink-0 text-muted-foreground/40" aria-hidden />
    </Button>
  );
}
