import { Goal, ListChecks, Network } from "lucide-react";
import { ComposerCapabilityChip } from "@/components/chat/ComposerCapabilityChip";
import { ActiveGoalChip } from "../ActiveGoalChip";
import type { ComposerAgentSelection } from "../draft/useComposerFormController";
import type { ResolvedComposerCapability } from "../composer-capabilities";
import { ORCHESTRATION_MODES, type GoalState } from "@mcode/contracts";

/** Props for Composer's attached capability controls. */
export interface ComposerAttachedCapabilitiesProps {
  threadId?: string;
  isNewThread: boolean;
  selection: ComposerAgentSelection;
  capabilities: ResolvedComposerCapability[];
  activeGoal: GoalState | null | undefined;
  goalPending: boolean;
  onDetachPlan(): void;
  onDetachGoal(): void;
  onDetachOrchestration(): void;
}

function ComposerPlanCapability({
  selection,
  capability,
  onDetach,
}: {
  selection: ComposerAgentSelection;
  capability: ResolvedComposerCapability | undefined;
  onDetach(): void;
}) {
  if (selection.interactionMode !== "plan" || !capability) return null;
  return (
    <ComposerCapabilityChip
      label={capability.label}
      icon={ListChecks}
      removeLabel={`Remove ${capability.label}`}
      onRemove={onDetach}
      testId="composer-capability-plan"
    />
  );
}

function ComposerPendingGoalCapability({
  goalPending,
  capability,
  onDetach,
}: {
  goalPending: boolean;
  capability: ResolvedComposerCapability | undefined;
  onDetach(): void;
}) {
  if (!goalPending || !capability) return null;
  return (
    <ComposerCapabilityChip
      label={capability.label}
      icon={Goal}
      removeLabel={`Remove ${capability.label}`}
      onRemove={onDetach}
      testId="composer-capability-goal-pending"
    />
  );
}

function ComposerOrchestrationCapability({
  selection,
  capability,
  onDetach,
}: {
  selection: ComposerAgentSelection;
  capability: ResolvedComposerCapability | undefined;
  onDetach(): void;
}) {
  if (selection.orchestrationMode !== ORCHESTRATION_MODES.PROACTIVE || !capability) return null;
  return (
    <ComposerCapabilityChip
      label={capability.label}
      icon={Network}
      removeLabel={`Remove ${capability.label}`}
      onRemove={onDetach}
      testId="composer-capability-orchestration"
    />
  );
}

function ComposerActiveGoalCapability({
  threadId,
  isNewThread,
  activeGoal,
}: Pick<ComposerAttachedCapabilitiesProps, "threadId" | "isNewThread" | "activeGoal">) {
  if (!threadId || isNewThread || !activeGoal) return null;
  return <ActiveGoalChip threadId={threadId} goal={activeGoal} />;
}

/** Renders the selected Plan, Goal, and orchestration capabilities. */
export function ComposerAttachedCapabilities({
  threadId,
  isNewThread,
  selection,
  capabilities,
  activeGoal,
  goalPending,
  onDetachPlan,
  onDetachGoal,
  onDetachOrchestration,
}: ComposerAttachedCapabilitiesProps) {
  const planCapability = capabilities.find((capability) => capability.id === "plan");
  const goalCapability = capabilities.find((capability) => capability.id === "goal");
  const orchestrationCapability = capabilities.find((capability) => capability.id === "orchestration");

  return (
    <>
      <ComposerPlanCapability selection={selection} capability={planCapability} onDetach={onDetachPlan} />
      <ComposerPendingGoalCapability goalPending={goalPending} capability={goalCapability} onDetach={onDetachGoal} />
      <ComposerOrchestrationCapability
        selection={selection}
        capability={orchestrationCapability}
        onDetach={onDetachOrchestration}
      />
      <ComposerActiveGoalCapability threadId={threadId} isNewThread={isNewThread} activeGoal={activeGoal} />
    </>
  );
}
