import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import type { ApprovalReviewMode, ContextWindowMode, OrchestrationMode, ReasoningLevel } from "@mcode/contracts";
import { ORCHESTRATION_MODES } from "@mcode/contracts";
import { INTERACTION_MODES, PERMISSION_MODES, type InteractionMode, type PermissionMode } from "@/transport";
import {
  getDefaultModelId,
  getDefaultProviderId,
  getDefaultReasoningLevel,
} from "@/lib/model-registry";

/** Mutable agent-selection values for one Composer session. */
export interface ComposerAgentSelection {
  modelId: string;
  provider: string;
  reasoning: ReasoningLevel;
  interactionMode: InteractionMode;
  permissionMode: PermissionMode;
  approvalReviewMode: ApprovalReviewMode;
  orchestrationMode: OrchestrationMode;
  copilotAgent: string | null;
  contextWindow: ContextWindowMode | null;
  thinking: boolean | null;
  codexFastMode: boolean | null;
}

/** State and updates for one Composer agent selection. */
export interface ComposerSelectionState {
  selection: ComposerAgentSelection;
  setSelection: Dispatch<SetStateAction<ComposerAgentSelection>>;
  updateSelection(patch: Partial<ComposerAgentSelection>): void;
}

type NullableSelectionField =
  | "copilotAgent"
  | "contextWindow"
  | "thinking"
  | "codexFastMode";

function retainCurrentWhenUndefined<Value>(current: Value, next: Value | undefined): Value {
  return next === undefined ? current : next;
}

function readNullableSelectionPatch<Field extends NullableSelectionField>(
  current: ComposerAgentSelection,
  patch: Partial<ComposerAgentSelection>,
  field: Field,
): ComposerAgentSelection[Field] {
  if (!Object.prototype.hasOwnProperty.call(patch, field)) return current[field];
  return patch[field] ?? null;
}

function hasSameComposerAgentSelection(
  current: ComposerAgentSelection,
  next: ComposerAgentSelection,
): boolean {
  return current.modelId === next.modelId
    && current.provider === next.provider
    && current.reasoning === next.reasoning
    && current.interactionMode === next.interactionMode
    && current.permissionMode === next.permissionMode
    && current.approvalReviewMode === next.approvalReviewMode
    && current.orchestrationMode === next.orchestrationMode
    && current.copilotAgent === next.copilotAgent
    && current.contextWindow === next.contextWindow
    && current.thinking === next.thinking
    && current.codexFastMode === next.codexFastMode;
}

/** Creates the selection values used before a Composer restores a draft or thread session. */
export function createDefaultComposerAgentSelection(): ComposerAgentSelection {
  return {
    modelId: getDefaultModelId(),
    provider: getDefaultProviderId(),
    reasoning: getDefaultReasoningLevel(),
    interactionMode: INTERACTION_MODES.BUILD,
    permissionMode: PERMISSION_MODES.FULL,
    approvalReviewMode: "manual",
    orchestrationMode: ORCHESTRATION_MODES.STANDARD,
    copilotAgent: null,
    contextWindow: null,
    thinking: null,
    codexFastMode: null,
  };
}

/** Merges a partial selection while retaining the Composer's undefined and nullable field semantics. */
export function mergeComposerAgentSelection(
  current: ComposerAgentSelection,
  patch: Partial<ComposerAgentSelection>,
): ComposerAgentSelection {
  const next = {
    modelId: retainCurrentWhenUndefined(current.modelId, patch.modelId),
    provider: retainCurrentWhenUndefined(current.provider, patch.provider),
    reasoning: retainCurrentWhenUndefined(current.reasoning, patch.reasoning),
    interactionMode: retainCurrentWhenUndefined(current.interactionMode, patch.interactionMode),
    permissionMode: retainCurrentWhenUndefined(current.permissionMode, patch.permissionMode),
    approvalReviewMode: retainCurrentWhenUndefined(current.approvalReviewMode, patch.approvalReviewMode),
    orchestrationMode: retainCurrentWhenUndefined(
      current.orchestrationMode,
      patch.orchestrationMode,
    ),
    copilotAgent: readNullableSelectionPatch(current, patch, "copilotAgent"),
    contextWindow: readNullableSelectionPatch(current, patch, "contextWindow"),
    thinking: readNullableSelectionPatch(current, patch, "thinking"),
    codexFastMode: readNullableSelectionPatch(current, patch, "codexFastMode"),
  };
  return hasSameComposerAgentSelection(current, next) ? current : next;
}

/** Owns mutable agent-selection state for one Composer form. */
export function useComposerSelectionState(): ComposerSelectionState {
  const [selection, setSelection] = useState<ComposerAgentSelection>(
    createDefaultComposerAgentSelection,
  );
  const updateSelection = useCallback((patch: Partial<ComposerAgentSelection>) => {
    setSelection((current) => mergeComposerAgentSelection(current, patch));
  }, []);

  return { selection, setSelection, updateSelection };
}
