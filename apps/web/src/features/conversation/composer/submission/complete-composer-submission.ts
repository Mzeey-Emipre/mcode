import type { ComposerAgentSelection, ComposerFormController } from "../draft/useComposerFormController";
import type { PreparedComposerSubmission } from "./composer-submission-types";
import { useSettingsStore } from "@/stores/settingsStore";

/** Inputs for post-transport Composer cleanup. */
export interface CompleteComposerSubmissionOptions {
  form: ComposerFormController;
  submission: PreparedComposerSubmission;
  finishEditing(): void;
}

/** Applies success-only form, queue, and default-setting updates. */
export function completeSuccessfulComposerSubmission({
  form,
  submission,
  finishEditing,
}: CompleteComposerSubmissionOptions): void {
  const submittedFormIsCurrent = form.confirmSubmittedDispatch();
  finishEditing();
  if (submission.goalObjective && submittedFormIsCurrent) form.setGoalPending(false);
  updateAgentDefaults(submittedFormIsCurrent, submission.snapshot.selection);
  form.focus();
}

/** Persists changed interaction defaults after a successful current-form submission. */
function updateAgentDefaults(
  submittedFormIsCurrent: boolean,
  selection: ComposerAgentSelection,
): void {
  const { settings, loaded, update } = useSettingsStore.getState();
  if (!submittedFormIsCurrent || !loaded || hasCurrentAgentDefaults(selection)) return;
  void update({
    agent: {
      defaults: {
        mode: selection.interactionMode,
        permission: selection.permissionMode,
      },
    },
  });

  function hasCurrentAgentDefaults(currentSelection: ComposerAgentSelection): boolean {
    return (
      currentSelection.interactionMode === settings.agent.defaults.mode
      && currentSelection.permissionMode === settings.agent.defaults.permission
    );
  }
}
