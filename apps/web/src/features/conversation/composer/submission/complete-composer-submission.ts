import type { ComposerAgentSelection, ComposerFormController } from "../draft/useComposerFormController";
import type { ComposerReplyContext, PreparedComposerSubmission } from "./composer-submission-types";
import { useReplyStore } from "@/stores/replyStore";
import { useSettingsStore } from "@/stores/settingsStore";

/** Inputs for post-transport Composer cleanup. */
export interface CompleteComposerSubmissionOptions {
  threadId?: string;
  form: ComposerFormController;
  submission: PreparedComposerSubmission;
  replyContext?: ComposerReplyContext;
  finishEditing(): void;
}

/** Applies success-only form, reply, queue, and default-setting updates. */
export function completeSuccessfulComposerSubmission({
  threadId,
  form,
  submission,
  replyContext,
  finishEditing,
}: CompleteComposerSubmissionOptions): void {
  const submittedFormIsCurrent = form.isUnchangedSince(submission.snapshot.revision);
  if (submittedFormIsCurrent) form.clear("dispatch");
  clearMatchingReply(threadId, replyContext);
  finishEditing();
  if (submission.goalObjective && submittedFormIsCurrent) form.setGoalPending(false);
  updateAgentDefaults(submittedFormIsCurrent, submission.snapshot.selection);
  form.focus();
}

/** Clears a reply only when it still identifies the message just submitted. */
function clearMatchingReply(
  threadId: string | undefined,
  replyContext: ComposerReplyContext | undefined,
): void {
  if (!threadId) return;
  const activeReply = useReplyStore.getState().getReply(threadId);
  if (activeReply?.messageId === replyContext?.messageId) {
    useReplyStore.getState().clearReply(threadId);
  }
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
