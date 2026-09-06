import { ModelSelector } from "@/components/chat/ModelSelector";
import { ComposerAccessControls } from "./ComposerAccessControls";
import { ComposerAttachedCapabilities } from "./ComposerAttachedCapabilities";
import {
  ComposerModelPreferences,
  type ComposerModelPreferenceDefaults,
} from "./ComposerModelPreferences";
import type { ComposerAgentSelection } from "../draft/useComposerFormController";
import type { ResolvedComposerCapability } from "../composer-capabilities";
import type { GoalState, ReasoningLevel } from "@mcode/contracts";

/** Props for the Composer's model, permission, and attached-capability controls. */
export interface ComposerAgentControlsProps {
  threadId?: string;
  workspaceId?: string;
  branchFromMessageId?: string;
  isNewThread: boolean;
  selection: ComposerAgentSelection;
  defaults: ComposerModelPreferenceDefaults;
  reasoningLevels: ReasoningLevel[];
  capabilities: ResolvedComposerCapability[];
  activeGoal: GoalState | null | undefined;
  goalPending: boolean;
  isModelLocked: boolean;
  isProviderLocked: boolean;
  permissionLocked: boolean;
  approvalReviewSupported: boolean;
  showInlineOptions: boolean;
  showModelPreferences?: boolean;
  onSelectionChange(patch: Partial<ComposerAgentSelection>): void;
  onSelectionTouched(): void;
  onDetachPlan(): void;
  onDetachGoal(): void;
  onDetachOrchestration(): void;
}

/** Renders controls that select an agent and configure its turn settings. */
export function ComposerAgentControls({
  threadId,
  workspaceId,
  branchFromMessageId,
  isNewThread,
  selection,
  defaults,
  reasoningLevels,
  capabilities,
  activeGoal,
  goalPending,
  isModelLocked,
  isProviderLocked,
  permissionLocked,
  approvalReviewSupported,
  showInlineOptions,
  showModelPreferences = true,
  onSelectionChange,
  onSelectionTouched,
  onDetachPlan,
  onDetachGoal,
  onDetachOrchestration,
}: ComposerAgentControlsProps) {
  return (
    <>
      <ModelSelector
        selectedModelId={selection.modelId}
        selectedProviderId={selection.provider}
        onSelect={(modelId, provider) => onSelectionChange({ modelId, provider })}
        locked={isModelLocked}
        providerLocked={isProviderLocked}
      />
      <ComposerModelPreferences
        threadId={threadId}
        branchFromMessageId={branchFromMessageId}
        show={showModelPreferences}
        selection={selection}
        defaults={defaults}
        reasoningLevels={reasoningLevels}
        onSelectionChange={onSelectionChange}
      />
      <ComposerAccessControls
        threadId={threadId}
        workspaceId={workspaceId}
        branchFromMessageId={branchFromMessageId}
        selection={selection}
        isModelLocked={isModelLocked}
        permissionLocked={permissionLocked}
        approvalReviewSupported={approvalReviewSupported}
        showInlineOptions={showInlineOptions}
        onSelectionChange={onSelectionChange}
        onSelectionTouched={onSelectionTouched}
      />
      <ComposerAttachedCapabilities
        threadId={threadId}
        isNewThread={isNewThread}
        selection={selection}
        capabilities={capabilities}
        activeGoal={activeGoal}
        goalPending={goalPending}
        onDetachPlan={onDetachPlan}
        onDetachGoal={onDetachGoal}
        onDetachOrchestration={onDetachOrchestration}
      />
    </>
  );
}
