import { resolveSubagentDisplayName } from "@mcode/contracts";
import { Button } from "@/components/ui/button";
import { SubagentIdentityGlyph } from "@/components/ui/SubagentIdentityGlyph";
import type { HookExecution, ToolCall } from "@/transport/types";
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
  /** Opens the selected canonical child through the composition root. */
  onSubagentSelect?: (id: string) => void;
}

/** Renders one identity-only sub-agent lifecycle row in the chat narrative. */
export function SubagentRow({ participants, lifecycle, onSubagentSelect }: SubagentRowProps) {
  const lifecycleLabel = lifecycle === "started" ? "started working" : lifecycle;

  return (
    <div className={`${NARRATIVE_TOOL_ROW} gap-2`}>
      <div className="flex min-w-0 shrink gap-1 overflow-hidden">
        {participants.map((participant) => {
          const resolvedIdentity = resolveSubagentDisplayName(participant.toolInput);
          const identity = resolvedIdentity ?? "Subagent";
          return (
            <Button
              key={participant.id}
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onSubagentSelect?.(participant.id)}
              className="min-w-0 max-w-40 shrink gap-1 rounded-full px-2 text-left transition-colors duration-150 motion-reduce:transition-none hover:bg-muted/30"
              aria-label={`Open ${identity} subagent details`}
            >
              <SubagentIdentityGlyph
                identity={identity}
                hasExplicitIdentity={resolvedIdentity !== undefined}
                className="size-4"
                size={12}
              />
              <span className="min-w-0 truncate text-xs font-medium text-foreground/85">
                {identity}
              </span>
            </Button>
          );
        })}
      </div>
      <span className="shrink-0 text-xs text-muted-foreground">
        {lifecycleLabel}
      </span>
    </div>
  );
}
