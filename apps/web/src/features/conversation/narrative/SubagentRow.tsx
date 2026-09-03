import { useState } from "react";
import { formatSubagentDisplayName } from "@mcode/contracts";
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

interface VisibleSubagentParticipant {
  participant: ToolCall;
  lifecycle: SubagentLifecycle;
}

interface SubagentParticipantView {
  identity: string;
  title: string;
  paletteSeed: string;
  detailTarget: string | undefined;
  hasDetailTarget: boolean;
  hasExplicitIdentity: boolean;
  status: string;
  unavailableMessage: string;
}

interface SubagentParticipantProps extends VisibleSubagentParticipant {
  unavailableDetailId: string | undefined;
  onSubagentSelect: SubagentRowProps["onSubagentSelect"];
  onUnavailableDetail: (id: string) => void;
}

interface AggregateSubagentButtonProps {
  label: string;
  target: SubagentRosterTarget;
  onOpenSubagents: SubagentRowProps["onOpenSubagents"];
}

function terminalStatus(toolCall: ToolCall): "Completed" | "Interrupted" | "Failed" {
  if (toolCall.isCancelled) {
    return "Interrupted";
  }
  return toolCall.isError ? "Failed" : "Completed";
}

function lifecycleLabel(lifecycle: SubagentLifecycle): string {
  if (lifecycle === "started") return "started working";
  if (lifecycle === "updated") return "updated";
  return "finished";
}

function remainingLabel(activities: readonly SubagentActivity[]): string {
  const working = activities.filter((activity) => activity.lifecycle !== "finished").length;
  const finished = activities.length - working;
  const labels: string[] = [];
  if (working > 0) labels.push(`${working} working`);
  if (finished > 0) labels.push(`${finished} finished`);
  return labels.map((label, index) => index === 0 ? `+${label}` : label).join(", ");
}

function transcriptUnavailableMessage(providerName: string | undefined): string {
  return providerName
    ? `${providerName} did not provide this subagent’s transcript.`
    : "This provider did not provide this subagent’s transcript.";
}

function groupedSubagentActivities(
  activities: readonly SubagentActivity[] | undefined,
): readonly SubagentActivity[] | undefined {
  if (!activities || activities.length <= 1) return undefined;
  return activities;
}

function visibleSubagentParticipants(
  groupedActivities: readonly SubagentActivity[] | undefined,
  participants: readonly ToolCall[],
  lifecycle: SubagentLifecycle,
): VisibleSubagentParticipant[] {
  if (groupedActivities) {
    return groupedActivities.slice(0, 2).map((activity) => ({
      participant: activity.participants.at(-1) ?? activity.toolCall,
      lifecycle: activity.lifecycle,
    }));
  }
  return participants.slice(0, 2).map((participant) => ({ participant, lifecycle }));
}

function aggregateSubagentTarget(
  activities: readonly SubagentActivity[],
): SubagentRosterTarget {
  return activities.some((activity) => activity.lifecycle !== "finished")
    ? "active"
    : "finished";
}

function participantTranscriptUnavailableMessage(participant: ToolCall): string {
  const detail = participant.subagentPresentation?.detail;
  return transcriptUnavailableMessage(
    detail?.kind === "transcript-unavailable" ? detail.providerName : undefined,
  );
}

function participantIdentity(participant: ToolCall): string {
  return participant.subagentPresentation?.displayName ?? "Subagent";
}

function participantIdentityKey(participant: ToolCall): string {
  return participant.subagentPresentation?.identityKey ?? participant.id;
}

function participantTitle(participant: ToolCall): string {
  const task = participant.subagentPresentation?.task;
  return task ? formatSubagentDisplayName(task) : participantIdentity(participant);
}

function participantHasDetailTarget(participant: ToolCall): boolean {
  return participantDetailTarget(participant) !== undefined;
}

function participantDetailTarget(participant: ToolCall): string | undefined {
  const detail = participant.subagentPresentation?.detail;
  if (detail?.kind === "canonical-child") return detail.threadId;
  return detail?.kind === "canonical-alias" ? detail.identityKey : undefined;
}

function participantStatus(participant: ToolCall, lifecycle: SubagentLifecycle): string {
  return lifecycle === "finished" ? terminalStatus(participant) : "Active";
}

function projectSubagentParticipant(
  participant: ToolCall,
  lifecycle: SubagentLifecycle,
): SubagentParticipantView {
  return {
    identity: participantIdentity(participant),
    title: participantTitle(participant),
    paletteSeed: participantDetailTarget(participant) ?? participantIdentityKey(participant),
    detailTarget: participantDetailTarget(participant),
    hasDetailTarget: participantHasDetailTarget(participant),
    hasExplicitIdentity: participant.subagentPresentation?.hasExplicitIdentity ?? false,
    status: participantStatus(participant, lifecycle),
    unavailableMessage: participantTranscriptUnavailableMessage(participant),
  };
}

function handleSubagentSelection(
  participant: ToolCall,
  lifecycle: SubagentLifecycle,
  detailTarget: string | undefined,
  onSubagentSelect: SubagentRowProps["onSubagentSelect"],
  onUnavailableDetail: (id: string) => void,
): void {
  if (!detailTarget) {
    onUnavailableDetail(participant.id);
    return;
  }
  onSubagentSelect?.(
    detailTarget,
    lifecycle === "finished" ? "finished" : "active",
  );
}

function SubagentTranscriptNotice({
  participantId,
  unavailableDetailId,
  message,
}: {
  participantId: string;
  unavailableDetailId: string | undefined;
  message: string;
}) {
  if (unavailableDetailId !== participantId || !message) return null;

  return (
    <span data-testid="subagent-transcript-unavailable" role="status" className="text-xs text-muted-foreground">
      {message}
    </span>
  );
}

function SubagentParticipant({
  participant,
  lifecycle,
  unavailableDetailId,
  onSubagentSelect,
  onUnavailableDetail,
}: SubagentParticipantProps) {
  const view = projectSubagentParticipant(participant, lifecycle);

  return (
    <span className="flex min-w-0 shrink items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => handleSubagentSelection(
          participant,
          lifecycle,
          view.detailTarget,
          onSubagentSelect,
          onUnavailableDetail,
        )}
        className="min-w-0 shrink gap-1 rounded-full px-2 text-left transition-colors duration-150 motion-reduce:transition-none hover:bg-muted/30"
        aria-label={`${view.hasDetailTarget ? "Open" : "Show"} ${view.title} subagent details`}
        aria-describedby={`subagent-status-${participant.id}`}
      >
        <SubagentIdentityGlyph
          identity={view.identity}
          hasExplicitIdentity={view.hasExplicitIdentity}
          paletteSeed={view.paletteSeed}
          className="size-4"
          size={12}
        />
        <span className="min-w-0 truncate text-xs font-medium text-foreground/85">
          {view.title}
        </span>
      </Button>
      <span id={`subagent-status-${participant.id}`} role="status" className="sr-only">
        {view.status}
      </span>
      <SubagentTranscriptNotice
        participantId={participant.id}
        unavailableDetailId={unavailableDetailId}
        message={view.unavailableMessage}
      />
      <span className="shrink-0 text-xs text-muted-foreground">
        {lifecycleLabel(lifecycle)}
      </span>
    </span>
  );
}

function AggregateSubagentButton({
  label,
  target,
  onOpenSubagents,
}: AggregateSubagentButtonProps) {
  if (!label) return null;

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={() => onOpenSubagents?.(target)}
      className="shrink-0 justify-start rounded-full px-2 text-left text-xs text-muted-foreground hover:bg-muted/30"
      aria-label={`Open full Subagents roster, ${label}`}
    >
      <span className="whitespace-nowrap">{label}</span>
    </Button>
  );
}

/** Renders one identity-only sub-agent lifecycle row in the chat narrative. */
export function SubagentRow({
  participants,
  lifecycle,
  onSubagentSelect,
  onOpenSubagents,
  activities,
}: SubagentRowProps) {
  const [unavailableDetailId, setUnavailableDetailId] = useState<string>();
  const groupedActivities = groupedSubagentActivities(activities);
  const visibleParticipants = visibleSubagentParticipants(
    groupedActivities,
    participants,
    lifecycle,
  );
  const remainingActivities = groupedActivities?.slice(2) ?? [];
  const aggregateLabel = remainingActivities.length > 0 ? remainingLabel(remainingActivities) : "";
  const aggregateTarget = aggregateSubagentTarget(remainingActivities);

  return (
    <div className={`${NARRATIVE_TOOL_ROW} min-w-0 gap-2`}>
      <div className={`flex min-w-0 flex-1 items-center overflow-hidden ${groupedActivities ? "gap-1" : "gap-2"}`}>
        {visibleParticipants.map(({ participant, lifecycle: participantLifecycle }) => (
          <SubagentParticipant
            key={participant.id}
            participant={participant}
            lifecycle={participantLifecycle}
            unavailableDetailId={unavailableDetailId}
            onSubagentSelect={onSubagentSelect}
            onUnavailableDetail={setUnavailableDetailId}
          />
        ))}
      </div>
      <AggregateSubagentButton
        label={aggregateLabel}
        target={aggregateTarget}
        onOpenSubagents={onOpenSubagents}
      />
    </div>
  );
}
