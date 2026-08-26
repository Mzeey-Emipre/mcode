import type { ComposerDraft } from "@/stores/composerDraftStore";
import { INTERACTION_MODES, PERMISSION_MODES } from "@/transport";
import { ORCHESTRATION_MODES } from "@mcode/contracts";
import { resolveComposerSession, snapshotComposerDraft, type ComposerSession } from "@/lib/composer-session";
import { readWorkspaceThread } from "@/features/projects/state/workspace-selectors";
import { useSettingsStore } from "@/stores/settingsStore";
import { useThreadStore } from "@/stores/threadStore";
import {
  collectSpillPathsFromPendingAttachments,
  releaseBrowserCaptureSpills,
} from "@/features/preview/capture/browser-capture-spill";

/** Dependencies that transition a Composer draft between thread owners. */
export interface ComposerDraftOwnerTransition {
  previousThreadId: string | undefined;
  nextThreadId: string | undefined;
  draft: ComposerDraft;
  threadExists(threadId: string): boolean;
  saveDraft(threadId: string, draft: ComposerDraft): void;
}

/** Inputs that resolve the Composer session for the current thread owner. */
export interface ComposerSessionOwnerInput {
  threadId: string | undefined;
  getDraft(threadId: string): ComposerDraft | undefined;
}

function isComposerDraftOwnerChanging(
  previousThreadId: string | undefined,
  nextThreadId: string | undefined,
): previousThreadId is string {
  return previousThreadId !== undefined && previousThreadId !== nextThreadId;
}

function releaseOrphanedComposerDraft(draft: ComposerDraft): void {
  for (const attachment of draft.attachments) {
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
  }
  const spillPaths = collectSpillPathsFromPendingAttachments(draft.attachments);
  if (spillPaths.length > 0) void releaseBrowserCaptureSpills(spillPaths);
}

function readComposerThreadSettings(threadId: string | undefined) {
  if (!threadId) {
    return {
      interactionMode: INTERACTION_MODES.BUILD,
      orchestrationMode: ORCHESTRATION_MODES.STANDARD,
      permissionMode: PERMISSION_MODES.FULL,
      copilotAgent: null,
      contextWindow: null,
      thinking: null,
      codexFastMode: null,
    };
  }
  const settings = useThreadStore.getState().getThreadSettings(threadId);
  return {
    interactionMode: settings.interactionMode,
    orchestrationMode: settings.orchestrationMode,
    permissionMode: settings.permissionMode,
    copilotAgent: settings.copilotAgent ?? null,
    contextWindow: settings.contextWindow ?? null,
    thinking: settings.thinking ?? null,
    codexFastMode: settings.codexFastMode ?? null,
  };
}

function readComposerGlobalDefaults() {
  const { settings } = useSettingsStore.getState();
  return {
    interactionMode:
      settings.agent.defaults.mode === "plan" ? INTERACTION_MODES.PLAN : INTERACTION_MODES.BUILD,
    permissionMode: settings.agent.defaults.permission,
  };
}

/** Saves a departed draft when its thread exists or releases its browser resources when it does not. */
export function transitionComposerDraftOwner({
  previousThreadId,
  nextThreadId,
  draft,
  threadExists,
  saveDraft,
}: ComposerDraftOwnerTransition): void {
  if (!isComposerDraftOwnerChanging(previousThreadId, nextThreadId)) return;
  if (threadExists(previousThreadId)) {
    saveDraft(previousThreadId, snapshotComposerDraft(draft));
    return;
  }
  releaseOrphanedComposerDraft(draft);
}

/** Resolves the stored draft and settings that belong to the current Composer owner. */
export function resolveComposerSessionForOwner({
  threadId,
  getDraft,
}: ComposerSessionOwnerInput): ComposerSession {
  const threadSettings = readComposerThreadSettings(threadId);
  return resolveComposerSession({
    threadId,
    getDraft,
    threadRow: threadId ? readWorkspaceThread(threadId) : undefined,
    threadSettings,
    globalDefaults: readComposerGlobalDefaults(),
  });
}
