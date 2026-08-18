import { resolveSubagentDisplayName } from "@mcode/contracts";
import { Button } from "@/components/ui/button";
import { SubagentIdentityGlyph } from "@/components/ui/SubagentIdentityGlyph";
import type { HookExecution, ToolCall } from "@/transport/types";
import { NARRATIVE_TOOL_ROW } from "./narrative-layout";
import type { SubagentLifecycle } from "./subagent-lifecycle";
import type { SubagentActivity, SubagentRosterTarget } from "./types";

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
  onSubagentSelect?: (id: string, target: SubagentRosterTarget) => void;
  /** Opens the owning thread's Subagents roster for aggregate activity. */
  onOpenSubagents?: (target: SubagentRosterTarget) => void;
  /** Contiguous sibling Agent calls sharing one parent timeline unit. */
  activities?: readonly SubagentActivity[];
}

function lifecycleLabel(lifecycle: SubagentLifecycle): string {
  return lifecycle === "started" ? "started working" : lifecycle;
}

function remainingLabel(activities: readonly SubagentActivity[]): string {
  const working = activities.filter((activity) => activity.lifecycle !== "finished").length;
  const finished = activities.length - working;
  const labels: string[] = [];
  if (working > 0) labels.push(`${working} working`);
  if (finished > 0) labels.push(`${finished} finished`);
  return labels.map((label, index) => index === 0 ? `+${label}` : label).join(", ");
}

/** Renders one identity-only sub-agent lifecycle row in the chat narrative. */
export function SubagentRow({
  participants,
  lifecycle,
  onSubagentSelect,
  onOpenSubagents,
  activities,
}: SubagentRowProps) {
  const groupedActivities = activities && activities.length > 1 ? activities : undefined;
  const visibleParticipants = groupedActivities
    ? groupedActivities.slice(0, 2).map((activity) => ({
        participant: activity.participants.at(-1) ?? activity.toolCall,
        lifecycle: activity.lifecycle,
      }))
    : participants.slice(0, 2).map((participant) => ({ participant, lifecycle }));
  const remainingActivities = groupedActivities?.slice(2) ?? [];
  const aggregateLabel = remainingActivities.length > 0 ? remainingLabel(remainingActivities) : "";
  const aggregateTarget: SubagentRosterTarget = remainingActivities.some(
    (activity) => activity.lifecycle !== "finished",
  ) ? "active" : "finished";

  return (
    <div className={`${NARRATIVE_TOOL_ROW} min-w-0 gap-2`}>
      <div className={`flex min-w-0 flex-1 items-center overflow-hidden ${groupedActivities ? "gap-1" : "gap-2"}`}>
        {visibleParticipants.map(({ participant, lifecycle: participantLifecycle }) => {
          const resolvedIdentity = resolveSubagentDisplayName(participant.toolInput);
          const identity = resolvedIdentity ?? "Subagent";
          return (
            <span key={participant.id} className="flex min-w-0 shrink items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onSubagentSelect?.(
                  participant.id,
                  participantLifecycle === "finished" ? "finished" : "active",
                )}
                className="min-w-0 shrink gap-1 rounded-full px-2 text-left transition-colors duration-150 motion-reduce:transition-none hover:bg-muted/30"
                aria-label={`Open ${identity} subagent details`}
              >
                <SubagentIdentityGlyph
                  identity={identity}
                  hasExplicitIdentity={resolvedIdentity !== undefined}
                  paletteSeed={participant.id}
                  className="size-4"
                  size={12}
                />
                <span className="min-w-0 truncate text-xs font-medium text-foreground/85">
                  {identity}
                </span>
              </Button>
              <span className="shrink-0 text-xs text-muted-foreground">
                {lifecycleLabel(participantLifecycle)}
              </span>
            </span>
          );
        })}
      </div>
      {aggregateLabel && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onOpenSubagents?.(aggregateTarget)}
          className="shrink-0 justify-start rounded-full px-2 text-left text-xs text-muted-foreground hover:bg-muted/30"
          aria-label={`Open full Subagents roster, ${aggregateLabel}`}
        >
          <span className="whitespace-nowrap">{aggregateLabel}</span>
        </Button>
      )}
    </div>
  );
}
