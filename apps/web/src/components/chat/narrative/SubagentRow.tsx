import { resolveSubagentDisplayName } from "@mcode/contracts";
import { SubagentIdentityGlyph } from "@/components/subagents/SubagentIdentityGlyph";
import { Button } from "@/components/ui/button";
import type { HookExecution, ToolCall } from "@/transport/types";
import { openSubagentDetail } from "@/lib/open-subagent-detail";
import { NARRATIVE_TOOL_ROW } from "./narrative-layout";
import type { SubagentLifecycle } from "./subagent-lifecycle";

interface SubagentRowProps {
  toolCall: ToolCall;
  participants: readonly ToolCall[];
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
export function SubagentRow({ participants, lifecycle }: SubagentRowProps) {
  const lifecycleLabel = lifecycle === "started" ? "started working" : lifecycle;

  return (
    <div className={`${NARRATIVE_TOOL_ROW} gap-1`}>
      {participants.map((participant) => {
        const resolvedIdentity = resolveSubagentDisplayName(participant.toolInput);
        const identity = resolvedIdentity ?? "Subagent";
        return (
          <Button
            key={participant.id}
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => openSubagentDetail(
              participant.id,
              participant.isComplete ? "finished" : "active",
            )}
            className="min-w-0 max-w-40 gap-1.5 rounded-sm px-1.5 text-left transition-colors duration-150 motion-reduce:transition-none hover:bg-muted/30"
            aria-label={`Open ${identity} subagent details`}
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
          </Button>
        );
      })}
      <span className="min-w-0 truncate text-xs text-muted-foreground">
        {lifecycleLabel}
      </span>
    </div>
  );
}
