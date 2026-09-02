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
import {
  useComposerDraftStore,
  type SelectedTextCommentEditorDraft,
} from "@/stores/composerDraftStore";
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
  selectedTextCommentEditor?: SelectedTextCommentEditorDraft;
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
  selectedTextCommentEditor?: SelectedTextCommentEditorDraft;
  attachments: PendingAttachment[];
  selection: ComposerAgentSelection;
  goalPending: boolean;
}

interface SubmittedDraftClear {
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
  setSelectedTextComments(
    comments: readonly SelectedTextComment[],
    editor?: SelectedTextCommentEditorDraft,
  ): void;
  setSelectedTextCommentEditor(editor: SelectedTextCommentEditorDraft | undefined): void;
  requestSelectedTextCommentEditorDismissal(): string | null;
  updateSelection(patch: Partial<ComposerAgentSelection>): void;
  setGoalPending(value: boolean): void;
  markAgentSettingsTouched(): void;
  readSubmission(): ComposerFormSubmission;
  isUnchangedSince(revision: number): boolean;
  snapshotAttachmentMetas(): AttachmentMeta[];
  restoreQueued(message: QueuedMessage): void;
  clearSubmittedDraft(submission: ComposerFormSubmission): boolean;
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
  const [selectedTextCommentEditor, setSelectedTextCommentEditor] =
    useState<SelectedTextCommentEditorDraft | undefined>();
  const [goalPending, setGoalPending] = useState(false);
  const { selection, setSelection, updateSelection } = useComposerSelectionState();
  const editorRef = useRef<LexicalEditor | null>(null);
  const attachments = useComposerAttachments({ isNewThread, threadId, workspaceId });
  const {
    appendAttachments,
    collectAndClearAttachments,
    detachAttachments,
    releaseAttachments,
    replaceAttachments,
  } = attachments;
  const previousThreadIdRef = useRef<string | undefined>(threadId);
  const draftRef = useRef({
    input,
    mentions,
    selectedTextComments,
    selectedTextCommentEditor,
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
    if (submittedDraftClear) releaseAttachments(submittedDraftClear.attachments);
    setInput(text);
    setMentions([...nextMentions]);
  }, [releaseAttachments]);

  const replaceDraft = useCallback(
    (text: string, nextMentions: readonly MessageMention[] = [], italic = false) => {
      updateDraft(text, nextMentions);
      if (editorRef.current) {
        writeComposerContent(editorRef.current, text, nextMentions, italic);
      }
    },
    [updateDraft],
  );

  const setSelectedTextCommentDraft = useCallback(function setSelectedTextCommentDraft(
    comments: readonly SelectedTextComment[],
    editor?: SelectedTextCommentEditorDraft,
  ) {
    const submittedDraftClear = submittedDraftClearRef.current;
    submittedDraftClearRef.current = null;
    if (submittedDraftClear) releaseAttachments(submittedDraftClear.attachments);
    const nextComments = [...comments];
    const nextEditor = arguments.length > 1
      ? editor
      : draftRef.current.selectedTextCommentEditor;
    const nextDraft = {
      ...draftRef.current,
      selectedTextComments: nextComments,
      selectedTextCommentEditor: nextEditor,
    };
    draftRef.current = nextDraft;
    setSelectedTextComments(nextComments);
    setSelectedTextCommentEditor(nextEditor);
    if (!threadId) return;
    saveDraft(threadId, snapshotComposerDraft(nextDraft));
  }, [releaseAttachments, saveDraft, threadId]);

  const setSelectedTextCommentEditorDraft = useCallback((
    editor: SelectedTextCommentEditorDraft | undefined,
  ) => {
    setSelectedTextCommentDraft(draftRef.current.selectedTextComments, editor);
  }, [setSelectedTextCommentDraft]);

  const requestSelectedTextCommentEditorDismissal = useCallback((): string | null => {
    const editor = selectedTextCommentEditor;
    if (!editor) return null;
    const saved = editor.commentId
      ? selectedTextComments.find((comment) => comment.id === editor.commentId)
      : undefined;
    const isDirty = saved
      ? editor.note !== saved.note || JSON.stringify(editor.mentions) !== JSON.stringify(saved.mentions)
      : editor.note.trim().length > 0 || editor.mentions.length > 0;
    if (!isDirty) return null;
    if (!editor.outsideWarned) {
      setSelectedTextCommentEditorDraft({ ...editor, outsideWarned: true });
      return "Repeat this action to discard this comment.";
    }
    setSelectedTextCommentEditorDraft(undefined);
    return null;
  }, [selectedTextCommentEditor, selectedTextComments, setSelectedTextCommentEditorDraft]);

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
    const draft = draftRef.current;
    return {
      revision: submissionRevisionRef.current,
      rawInput: message.text,
      mentions: message.mentions,
      selectedTextComments: draft.selectedTextComments,
      selectedTextCommentEditor: draft.selectedTextCommentEditor,
      attachments: attachments.attachments,
      selection: { ...selection },
      goalPending,
    };
  }, [
    attachments.attachments,
    goalPending,
    input,
    mentions,
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
      replaceAttachments(restored.attachments);
      updateSelection(restored.selection);
      setGoalPending(restored.goalPending);
      focus();
    },
    [focus, replaceAttachments, replaceDraft, updateSelection],
  );

  const clear = useCallback(
    (reason: "dispatch" | "queue-cancel") => {
      const currentAttachments = collectAndClearAttachments();
      replaceDraft("");
      setSelectedTextComments([]);
      setSelectedTextCommentEditor(undefined);
      if (reason === "dispatch" && threadId) clearDraft(threadId);
      return currentAttachments;
    },
    [clearDraft, collectAndClearAttachments, replaceDraft, threadId],
  );

  const discardSubmittedDraftClear = useCallback(() => {
    const submittedDraftClear = submittedDraftClearRef.current;
    submittedDraftClearRef.current = null;
    if (submittedDraftClear) releaseAttachments(submittedDraftClear.attachments);
  }, [releaseAttachments]);

  const clearSubmittedDraft = useCallback((submission: ComposerFormSubmission): boolean => {
    if (submissionRevisionRef.current !== submission.revision) return false;
    const dispatchedAttachments = detachAttachments();
    replaceDraft("");
    setSelectedTextComments([]);
    setSelectedTextCommentEditor(undefined);
    if (threadId) clearDraft(threadId);
    submittedDraftClearRef.current = {
      attachments: dispatchedAttachments,
    };
    return true;
  }, [clearDraft, detachAttachments, replaceDraft, threadId]);

  const confirmSubmittedDispatch = useCallback((): boolean => {
    const submittedDraftClear = submittedDraftClearRef.current;
    submittedDraftClearRef.current = null;
    if (!submittedDraftClear) return false;
    releaseAttachments(submittedDraftClear.attachments);
    return true;
  }, [releaseAttachments]);

  useEffect(() => {
    draftRef.current = {
      input,
      mentions,
      selectedTextComments,
      selectedTextCommentEditor,
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
      && !selectedTextCommentEditor
      && attachments.attachments.length === 0
    ) return;
    discardSubmittedDraftClear();
  }, [
    attachments.attachments.length,
    discardSubmittedDraftClear,
    input,
    mentions.length,
    selectedTextComments.length,
    selectedTextCommentEditor,
  ]);

  useEffect(() => {
    submissionRevisionRef.current += 1;
  }, [
    attachments.attachments,
    goalPending,
    input,
    mentions,
    selectedTextComments,
    selectedTextCommentEditor,
    selection,
  ]);

  useEffect(() => {
    if (!previewReferenceScopeId) return;
    const incoming = usePreviewReferenceQueueStore
      .getState()
      .drainPreviewReferences(previewReferenceScopeId);
    if (incoming.length === 0) return;

    const { acceptedCount, droppedCount } = appendAttachments(incoming);
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
  }, [appendAttachments, previewReferenceQueueSignal, previewReferenceScopeId]);

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

    // oxlint-disable-next-line react/set-state-in-effect -- The persisted draft session is the source of truth when its owner changes.
    setInput(session.input);
    setMentions(session.mentions);
    setSelectedTextComments(session.selectedTextComments);
    setSelectedTextCommentEditor(session.selectedTextCommentEditor);
    replaceAttachments(session.attachments);
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
  }, [getDraft, isNewThread, replaceAttachments, saveDraft, setSelection, threadId]);

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
  }, [branchFromMessageContent, branchFromMessageId]);

  useEffect(() => {
    if (!pendingPrefill) return;
    // oxlint-disable-next-line react/set-state-in-effect -- The prefill store supplies this external editor update.
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
    // oxlint-disable-next-line react/set-state-in-effect -- The stopped-turn recall store supplies this external editor update.
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
      selectedTextCommentEditor,
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
      selectedTextCommentEditor,
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
    setSelectedTextCommentEditor: setSelectedTextCommentEditorDraft,
    requestSelectedTextCommentEditorDismissal,
    updateSelection,
    setGoalPending: setGoalPendingValue,
    markAgentSettingsTouched,
    readSubmission,
    isUnchangedSince,
    snapshotAttachmentMetas: attachments.snapshotAttachmentMetas,
    restoreQueued,
    clearSubmittedDraft,
    confirmSubmittedDispatch,
    clear,
    focus,
  };
}
