import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { LexicalEditor } from "lexical";
import type { AttachmentMeta, Thread } from "@/transport";
import { INTERACTION_MODES } from "@/transport";
import type {
  ContextWindowMode,
  MessageMention,
  SelectedTextComment,
} from "@mcode/contracts";
import { ORCHESTRATION_MODES } from "@mcode/contracts";
import {
  getDefaultModelId,
  normalizeReasoningLevelForModel,
} from "@/lib/model-registry";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useThreadRecord } from "@/features/conversation/state";
import { useThreadStore } from "@/stores/threadStore";
import { usePreviewReferenceQueueStore } from "@/features/preview/state/previewReferenceQueueStore";
import { useToastStore } from "@/stores/toastStore";
import { snapshotComposerDraft } from "@/lib/composer-session";
import { writeComposerContent } from "./composer-editor-content";
import {
  useComposerAttachments,
  type ComposerAttachmentAppendResult,
} from "./useComposerAttachments";
import type { PendingAttachment } from "@/components/chat/AttachmentPreview";
import type { QueuedMessage } from "@/stores/queueStore";
import { extractComposerMessage } from "@/components/chat/lexical";
import {
  useComposerSelectionState,
  type ComposerAgentSelection,
} from "./composer-selection-state";
import { createQueuedComposerRestoreState } from "./queued-composer-restore";
import {
  resolveComposerSessionForOwner,
  transitionComposerDraftOwner,
} from "./composer-session-lifecycle";
import { reconcileComposerThreadModel } from "./composer-thread-model-reconciliation";

export type { ComposerAgentSelection } from "./composer-selection-state";

/** The rendered draft and agent selection for one Composer session. */
export interface ComposerFormState {
  text: string;
  mentions: MessageMention[];
  selectedTextComments: SelectedTextComment[];
  attachments: PendingAttachment[];
  selection: ComposerAgentSelection;
  goalPending: boolean;
  isDragOver: boolean;
  hasContent: boolean;
}

/** A stable snapshot that the submission controller can route without reading the editor itself. */
export interface ComposerFormSubmission {
  revision: number;
  rawInput: string;
  mentions: MessageMention[];
  selectedTextComments: SelectedTextComment[];
  attachments: PendingAttachment[];
  selection: ComposerAgentSelection;
  goalPending: boolean;
}

interface SubmittedDraftClear {
  ownerThreadId: string | undefined;
  submission: ComposerFormSubmission;
  attachments: PendingAttachment[];
}

/** Event bindings and lifecycle operations for the Composer attachment tray. */
export interface ComposerAttachmentBindings {
  attachmentInputRef: RefObject<HTMLInputElement | null>;
  preparationRevision: number;
  append(nextAttachments: PendingAttachment[]): ComposerAttachmentAppendResult;
  remove(id: string): void;
  awaitPreparation(): Promise<boolean>;
  consumeDeferredSubmit(): boolean;
  invalidatePreparation(): void;
  inputChange(event: React.ChangeEvent<HTMLInputElement>): void;
  pick(): void;
  paste(event: React.ClipboardEvent): void;
  dragEnter(event: React.DragEvent): void;
  dragLeave(event: React.DragEvent): void;
  dragOver(event: React.DragEvent): void;
  drop(event: React.DragEvent): boolean;
}

/** Inputs that identify the Composer session whose draft and agent selection this hook owns. */
export interface UseComposerFormControllerOptions {
  threadId?: string;
  isNewThread: boolean;
  workspaceId?: string;
  branchFromMessageId?: string;
  branchFromMessageContent?: string;
  activeThread?: Thread;
}

/** Form state, attachment bindings, and editor operations owned by one Composer session. */
export interface ComposerFormController {
  state: ComposerFormState;
  editorRef: RefObject<LexicalEditor | null>;
  defaults: {
    contextWindow: ContextWindowMode | undefined;
    thinking: boolean | undefined;
    globalCodexFast: boolean;
  };
  attachmentBindings: ComposerAttachmentBindings;
  updateDraft(text: string, mentions: readonly MessageMention[]): void;
  replaceDraft(text: string, mentions?: readonly MessageMention[], italic?: boolean): void;
  setSelectedTextComments(comments: readonly SelectedTextComment[]): void;
  updateSelection(patch: Partial<ComposerAgentSelection>): void;
  setGoalPending(value: boolean): void;
  markAgentSettingsTouched(): void;
  readSubmission(): ComposerFormSubmission;
  isUnchangedSince(revision: number): boolean;
  snapshotAttachmentMetas(): AttachmentMeta[];
  restoreQueued(message: QueuedMessage): void;
  clearSubmittedDraft(submission: ComposerFormSubmission): boolean;
  restoreFailedDispatch(): void;
  confirmSubmittedDispatch(): boolean;
  clear(reason: "dispatch" | "queue-cancel"): AttachmentMeta[];
  focus(): void;
}

/** Owns the draft, agent selection, editor, and restore lifecycle for one Composer session. */
export function useComposerFormController({
  threadId,
  isNewThread,
  workspaceId,
  branchFromMessageId,
  branchFromMessageContent,
  activeThread,
}: UseComposerFormControllerOptions): ComposerFormController {
  const [input, setInput] = useState("");
  const [mentions, setMentions] = useState<MessageMention[]>([]);
  const [selectedTextComments, setSelectedTextComments] = useState<SelectedTextComment[]>([]);
  const [goalPending, setGoalPending] = useState(false);
  const { selection, setSelection, updateSelection } = useComposerSelectionState();
  const editorRef = useRef<LexicalEditor | null>(null);
  const attachments = useComposerAttachments({ isNewThread, threadId, workspaceId });
  const previousThreadIdRef = useRef<string | undefined>(threadId);
  const draftRef = useRef({
    input,
    mentions,
    selectedTextComments,
    attachments: attachments.attachments,
    modelId: selection.modelId,
    provider: selection.provider,
    reasoning: selection.reasoning,
    contextWindow: undefined as ContextWindowMode | undefined,
    thinking: undefined as boolean | undefined,
    codexFastMode: null as boolean | null,
  });
  const agentSettingsTouchedRef = useRef(false);
  const submissionRevisionRef = useRef(0);
  const submittedDraftClearRef = useRef<SubmittedDraftClear | null>(null);
  const currentThreadIdRef = useRef(threadId);
  currentThreadIdRef.current = threadId;
  const threadSwitchRef = useRef(false);
  const lastServerThreadModelKeyRef = useRef("");
  const saveDraft = useComposerDraftStore((state) => state.saveDraft);
  const getDraft = useComposerDraftStore((state) => state.getDraft);
  const pendingPrefill = useComposerDraftStore((state) => state.pendingPrefill);
  const clearPendingPrefill = useComposerDraftStore((state) => state.clearPendingPrefill);
  const settingsLoaded = useSettingsStore((state) => state.loaded);
  const settingsDefaultProvider = useSettingsStore((state) => state.settings.model.defaults.provider);
  const settingsDefaultReasoning = useSettingsStore((state) => state.settings.model.defaults.reasoning);
  const settingsDefaultMode = useSettingsStore((state) => state.settings.agent.defaults.mode);
  const settingsDefaultPermission = useSettingsStore((state) => state.settings.agent.defaults.permission);
  const settingsDefaultContextWindow = useSettingsStore(
    (state) => state.settings.model.defaults.contextWindow,
  );
  const settingsDefaultThinking = useSettingsStore((state) => state.settings.model.defaults.thinking);
  const settingsGlobalCodexFast = useSettingsStore(
    (state) => state.settings.provider.codex.fastMode === true,
  );
  const persistedInteractionMode = useThreadRecord(
    threadId,
    (record) => record.settings.interactionMode,
  );
  const persistedOrchestrationMode = useThreadRecord(
    threadId,
    (record) => record.settings.orchestrationMode,
  );
  const composerRecallFromStop = useThreadRecord(
    threadId,
    (record) => record.composerRecallFromStop,
  );
  const clearComposerRecallFromStop = useThreadStore(
    (state) => state.clearComposerRecallFromStop,
  );
  const clearDraft = useComposerDraftStore((state) => state.clearDraft);
  const previewReferenceQueueSignal = usePreviewReferenceQueueStore((state) => state.signal);
  const previewReferenceScopeId = threadId ?? workspaceId;
  const markAgentSettingsTouched = useCallback(() => {
    agentSettingsTouchedRef.current = true;
  }, []);

  const updateDraft = useCallback((text: string, nextMentions: readonly MessageMention[]) => {
    const submittedDraftClear = submittedDraftClearRef.current;
    submittedDraftClearRef.current = null;
    if (submittedDraftClear) attachments.releaseAttachments(submittedDraftClear.attachments);
    setInput(text);
    setMentions([...nextMentions]);
  }, [attachments.releaseAttachments]);

  const replaceDraft = useCallback(
    (text: string, nextMentions: readonly MessageMention[] = [], italic = false) => {
      updateDraft(text, nextMentions);
      if (editorRef.current) {
        writeComposerContent(editorRef.current, text, nextMentions, italic);
      }
    },
    [updateDraft],
  );

  const setSelectedTextCommentDraft = useCallback((comments: readonly SelectedTextComment[]) => {
    const submittedDraftClear = submittedDraftClearRef.current;
    submittedDraftClearRef.current = null;
    if (submittedDraftClear) attachments.releaseAttachments(submittedDraftClear.attachments);
    const nextComments = [...comments];
    setSelectedTextComments(nextComments);
    if (!threadId) return;
    saveDraft(threadId, snapshotComposerDraft({
      ...draftRef.current,
      selectedTextComments: nextComments,
    }));
  }, [attachments.releaseAttachments, saveDraft, threadId]);

  const setGoalPendingValue = useCallback((value: boolean) => {
    setGoalPending(value);
  }, []);

  const focus = useCallback(() => {
    editorRef.current?.focus();
  }, []);

  const readSubmission = useCallback((): ComposerFormSubmission => {
    const message = editorRef.current
      ? extractComposerMessage(editorRef.current)
      : { text: input, mentions };
    return {
      revision: submissionRevisionRef.current,
      rawInput: message.text,
      mentions: message.mentions,
      selectedTextComments,
      attachments: attachments.attachments,
      selection: { ...selection },
      goalPending,
    };
  }, [
    attachments.attachments,
    goalPending,
    input,
    mentions,
    selectedTextComments,
    selection,
  ]);

  const isUnchangedSince = useCallback(
    (revision: number) => submissionRevisionRef.current === revision,
    [],
  );

  const restoreQueued = useCallback(
    (message: QueuedMessage) => {
      const restored = createQueuedComposerRestoreState(message);
      replaceDraft(restored.text, restored.mentions);
      attachments.replaceAttachments(restored.attachments);
      updateSelection(restored.selection);
      setGoalPending(restored.goalPending);
      focus();
    },
    [attachments.replaceAttachments, focus, replaceDraft, updateSelection],
  );

  const clear = useCallback(
    (reason: "dispatch" | "queue-cancel") => {
      const currentAttachments = attachments.collectAndClearAttachments();
      replaceDraft("");
      setSelectedTextComments([]);
      if (reason === "dispatch" && threadId) clearDraft(threadId);
      return currentAttachments;
    },
    [attachments.collectAndClearAttachments, clearDraft, replaceDraft, threadId],
  );

  const discardSubmittedDraftClear = useCallback(() => {
    const submittedDraftClear = submittedDraftClearRef.current;
    submittedDraftClearRef.current = null;
    if (submittedDraftClear) attachments.releaseAttachments(submittedDraftClear.attachments);
  }, [attachments.releaseAttachments]);

  const clearSubmittedDraft = useCallback((submission: ComposerFormSubmission): boolean => {
    if (submissionRevisionRef.current !== submission.revision) return false;
    const dispatchedAttachments = attachments.detachAttachments();
    replaceDraft("");
    setSelectedTextComments([]);
    if (threadId) clearDraft(threadId);
    submittedDraftClearRef.current = {
      ownerThreadId: threadId,
      submission,
      attachments: dispatchedAttachments,
    };
    return true;
  }, [attachments.detachAttachments, clearDraft, replaceDraft, threadId]);

  const restoreFailedDispatch = useCallback(() => {
    const submittedDraftClear = submittedDraftClearRef.current;
    submittedDraftClearRef.current = null;
    if (!submittedDraftClear) return;
    if (submittedDraftClear.ownerThreadId !== currentThreadIdRef.current) {
      attachments.releaseAttachments(submittedDraftClear.attachments);
      return;
    }
    replaceDraft(
      submittedDraftClear.submission.rawInput,
      submittedDraftClear.submission.mentions,
    );
    attachments.replaceAttachments(submittedDraftClear.attachments);
    setSelectedTextCommentDraft(submittedDraftClear.submission.selectedTextComments);
    focus();
  }, [attachments.releaseAttachments, attachments.replaceAttachments, focus, replaceDraft, setSelectedTextCommentDraft]);

  const confirmSubmittedDispatch = useCallback((): boolean => {
    const submittedDraftClear = submittedDraftClearRef.current;
    submittedDraftClearRef.current = null;
    if (!submittedDraftClear) return false;
    attachments.releaseAttachments(submittedDraftClear.attachments);
    return true;
  }, [attachments.releaseAttachments]);

  useEffect(() => {
    draftRef.current = {
      input,
      mentions,
      selectedTextComments,
      attachments: attachments.attachments,
      modelId: selection.modelId,
      provider: selection.provider,
      reasoning: selection.reasoning,
      contextWindow: selection.contextWindow ?? undefined,
      thinking: selection.thinking ?? undefined,
      codexFastMode: selection.codexFastMode,
    };
  });

  useEffect(() => {
    const submittedDraftClear = submittedDraftClearRef.current;
    if (!submittedDraftClear) return;
    if (
      input === ""
      && mentions.length === 0
      && selectedTextComments.length === 0
      && attachments.attachments.length === 0
    ) return;
    discardSubmittedDraftClear();
  }, [attachments.attachments.length, discardSubmittedDraftClear, input, mentions.length, selectedTextComments.length]);

  useEffect(() => {
    submissionRevisionRef.current += 1;
  }, [
    attachments.attachments,
    goalPending,
    input,
    mentions,
    selectedTextComments,
    selection,
  ]);

  useEffect(() => {
    if (!previewReferenceScopeId) return;
    const incoming = usePreviewReferenceQueueStore
      .getState()
      .drainPreviewReferences(previewReferenceScopeId);
    if (incoming.length === 0) return;

    const { acceptedCount, droppedCount } = attachments.appendAttachments(incoming);
    if (acceptedCount === 0) {
      queueMicrotask(() =>
        useToastStore.getState().show(
          "error",
          "Composer attachment limit reached",
          "Remove an attachment before adding a preview picture reference.",
        ),
      );
      return;
    }
    if (droppedCount > 0) {
      queueMicrotask(() =>
        useToastStore.getState().show(
          "error",
          "Composer attachment limit reached",
          `${droppedCount} preview reference(s) were not added.`,
        ),
      );
    }
  }, [attachments.appendAttachments, previewReferenceQueueSignal, previewReferenceScopeId]);

  useEffect(() => {
    if (!settingsLoaded || threadId) return;
    const validModelId = getDefaultModelId();
    const defaults = {
      modelId: validModelId,
      provider: settingsDefaultProvider ?? "claude",
      reasoning: normalizeReasoningLevelForModel(validModelId, settingsDefaultReasoning),
    };
    updateSelection(agentSettingsTouchedRef.current
      ? defaults
      : {
          ...defaults,
          interactionMode:
            settingsDefaultMode === "plan" ? INTERACTION_MODES.PLAN : INTERACTION_MODES.BUILD,
          permissionMode: settingsDefaultPermission,
        });
  }, [
    settingsDefaultMode,
    settingsDefaultPermission,
    settingsDefaultProvider,
    settingsDefaultReasoning,
    settingsLoaded,
    threadId,
    updateSelection,
  ]);

  useEffect(() => {
    const previousThreadId = previousThreadIdRef.current;
    transitionComposerDraftOwner({
      previousThreadId,
      nextThreadId: threadId,
      draft: draftRef.current,
      threadExists: (candidateThreadId) =>
        useWorkspaceStore.getState().threads.some((thread) => thread.id === candidateThreadId),
      saveDraft,
    });
    const session = resolveComposerSessionForOwner({ threadId, getDraft });

    setInput(session.input);
    setMentions(session.mentions);
    setSelectedTextComments(session.selectedTextComments);
    attachments.replaceAttachments(session.attachments);
    setSelection((current) => ({
      ...current,
      modelId: session.modelId,
      provider: session.provider,
      reasoning: session.reasoning,
      interactionMode: session.interactionMode,
      orchestrationMode:
        threadId
          ? useThreadStore.getState().getThreadSettings(threadId).orchestrationMode ?? ORCHESTRATION_MODES.STANDARD
          : ORCHESTRATION_MODES.STANDARD,
      permissionMode: session.permissionMode,
      copilotAgent: session.copilotAgent,
      contextWindow: session.contextWindow,
      thinking: session.thinking,
      codexFastMode: session.codexFastMode,
    }));
    if (editorRef.current) {
      writeComposerContent(editorRef.current, session.input, session.mentions);
    }
    if (!threadId) {
      agentSettingsTouchedRef.current = false;
      if (isNewThread) queueMicrotask(() => editorRef.current?.focus());
    }
    threadSwitchRef.current = true;
    previousThreadIdRef.current = threadId;
  }, [attachments.replaceAttachments, getDraft, isNewThread, saveDraft, setSelection, threadId]);

  useEffect(() => {
    setSelection((current) => {
      const normalizedReasoning = normalizeReasoningLevelForModel(
        current.modelId,
        current.reasoning,
      );
      return normalizedReasoning === current.reasoning
        ? current
        : { ...current, reasoning: normalizedReasoning };
    });
  }, [selection.modelId, selection.reasoning, setSelection]);

  useEffect(() => {
    if (!threadId) return;
    if (persistedInteractionMode === INTERACTION_MODES.PLAN || persistedInteractionMode === INTERACTION_MODES.BUILD) {
      updateSelection({ interactionMode: persistedInteractionMode });
    }
  }, [persistedInteractionMode, threadId, updateSelection]);

  useEffect(() => {
    if (!threadId || persistedOrchestrationMode === undefined) return;
    updateSelection({ orchestrationMode: persistedOrchestrationMode });
  }, [persistedOrchestrationMode, threadId, updateSelection]);

  useEffect(() => {
    if (!branchFromMessageId || !branchFromMessageContent || !editorRef.current) return;
    writeComposerContent(editorRef.current, branchFromMessageContent, [], true);
    setInput(branchFromMessageContent);
    setMentions([]);
    editorRef.current.focus();
  }, [branchFromMessageId]);

  useEffect(() => {
    if (!pendingPrefill) return;
    setInput(pendingPrefill);
    setMentions([]);
    if (!editorRef.current) return;
    writeComposerContent(editorRef.current, pendingPrefill);
    clearPendingPrefill();
    editorRef.current.focus();
  }, [clearPendingPrefill, pendingPrefill]);

  useEffect(() => {
    if (!composerRecallFromStop || !threadId) return;
    const text = composerRecallFromStop.text;
    clearComposerRecallFromStop(threadId);
    setInput(text);
    setMentions([]);
    if (!editorRef.current) return;
    writeComposerContent(editorRef.current, text);
    editorRef.current.focus();
  }, [clearComposerRecallFromStop, composerRecallFromStop, threadId]);

  useEffect(() => {
    const hasDraft = threadId ? getDraft(threadId) != null : false;
    const isRunning = threadId ? useThreadStore.getState().runningThreadIds.has(threadId) : false;
    const reconciliation = reconcileComposerThreadModel({
      activeThreadModel: activeThread?.model,
      activeThreadProvider: activeThread?.provider,
      threadSwitchPending: threadSwitchRef.current,
      hasDraft,
      isRunning,
      lastServerThreadModelKey: lastServerThreadModelKeyRef.current,
      selection,
    });
    if (reconciliation.serverModelKey) {
      lastServerThreadModelKeyRef.current = reconciliation.serverModelKey;
    }
    if (reconciliation.consumeThreadSwitch) {
      threadSwitchRef.current = false;
      return;
    }
    if (reconciliation.selectionPatch) updateSelection(reconciliation.selectionPatch);
  }, [
    activeThread?.model,
    activeThread?.provider,
    getDraft,
    selection,
    threadId,
    updateSelection,
  ]);

  const state = useMemo<ComposerFormState>(
    () => ({
      text: input,
      mentions,
      attachments: attachments.attachments,
      selectedTextComments,
      selection: { ...selection },
      goalPending,
      isDragOver: attachments.isDragOver,
      hasContent:
        input.trim().length > 0
        || selectedTextComments.length > 0
        || attachments.attachments.length > 0,
    }),
    [
      attachments.attachments,
      attachments.isDragOver,
      goalPending,
      input,
      mentions,
      selectedTextComments,
      selection,
    ],
  );

  const attachmentBindings = useMemo<ComposerAttachmentBindings>(
    () => ({
      attachmentInputRef: attachments.attachmentInputRef,
      preparationRevision: attachments.preparationRevision,
      append: attachments.appendAttachments,
      remove: attachments.removeAttachment,
      awaitPreparation: attachments.waitForPreparationsBeforeSubmit,
      consumeDeferredSubmit: attachments.consumeDeferredSubmit,
      invalidatePreparation: attachments.invalidatePreparations,
      inputChange: attachments.handleAttachmentInputChange,
      pick: attachments.handleAttachPick,
      paste: attachments.handlePaste,
      dragEnter: attachments.handleDragEnter,
      dragLeave: attachments.handleDragLeave,
      dragOver: attachments.handleDragOver,
      drop: attachments.handleDrop,
    }),
    [attachments],
  );

  return {
    state,
    editorRef,
    defaults: {
      contextWindow: settingsDefaultContextWindow,
      thinking: settingsDefaultThinking,
      globalCodexFast: settingsGlobalCodexFast,
    },
    attachmentBindings,
    updateDraft,
    replaceDraft,
    setSelectedTextComments: setSelectedTextCommentDraft,
    updateSelection,
    setGoalPending: setGoalPendingValue,
    markAgentSettingsTouched,
    readSubmission,
    isUnchangedSince,
    snapshotAttachmentMetas: attachments.snapshotAttachmentMetas,
    restoreQueued,
    clearSubmittedDraft,
    restoreFailedDispatch,
    confirmSubmittedDispatch,
    clear,
    focus,
  };
}
