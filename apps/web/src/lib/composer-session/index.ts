import type { PendingAttachment } from "@/components/chat/AttachmentPreview";
import type { ComposerDraft, SelectedTextCommentEditorDraft } from "@/stores/composerDraftStore";
import type {
  ContextWindowMode,
  MessageMention,
  ReasoningLevel,
  SelectedTextComment,
} from "@mcode/contracts";
import type { PermissionMode } from "@/transport";
import { INTERACTION_MODES, type InteractionMode } from "@/transport";
import type { WorkspaceThread } from "@/lib/workspace-thread";
import {
  getDefaultModelId,
  getDefaultProviderId,
  getDefaultReasoningLevel,
  normalizeReasoningLevelForModel,
  resolveThreadModelId,
} from "@/lib/model-registry";

/** Full per-thread composer state restored as one value on thread switch. */
export interface ComposerSession {
  input: string;
  mentions: MessageMention[];
  selectedTextComments: SelectedTextComment[];
  selectedTextCommentEditor?: SelectedTextCommentEditorDraft;
  attachments: PendingAttachment[];
  modelId: string;
  provider: string;
  reasoning: ReasoningLevel;
  interactionMode: InteractionMode;
  permissionMode: PermissionMode;
  copilotAgent: string | null;
  contextWindow: ContextWindowMode | null;
  thinking: boolean | null;
  codexFastMode: boolean | null;
}

/** Inputs for resolving a thread's composer session without React. */
export interface ResolveComposerSessionInput {
  threadId: string | undefined;
  getDraft: (threadId: string) => ComposerDraft | undefined;
  threadRow: WorkspaceThread | undefined;
  threadSettings: {
    interactionMode: InteractionMode;
    permissionMode: PermissionMode;
    copilotAgent: string | null;
    contextWindow: ContextWindowMode | null;
    thinking: boolean | null;
    codexFastMode: boolean | null;
  };
  globalDefaults: {
    interactionMode: InteractionMode;
    permissionMode: PermissionMode;
  };
}

/** Snapshot the outgoing thread draft for persistence. */
export function snapshotComposerDraft(draft: ComposerDraft): ComposerDraft {
  return {
    ...draft,
    mentions: draft.mentions?.map((mention) => ({
      ...mention,
      range: { ...mention.range },
    })),
    selectedTextComments: draft.selectedTextComments?.map((comment) => ({
      ...comment,
      source: { ...comment.source },
      mentions: comment.mentions.map((mention) => ({
        ...mention,
        range: { ...mention.range },
      })),
    })),
    selectedTextCommentEditor: snapshotSelectedTextCommentEditor(draft.selectedTextCommentEditor),
    attachments: draft.attachments.map((attachment) => ({ ...attachment })),
  };
}

function snapshotSelectedTextCommentEditor(
  editor: SelectedTextCommentEditorDraft | undefined,
): SelectedTextCommentEditorDraft | undefined {
  return editor && {
    ...editor,
    source: { ...editor.source },
    mentions: editor.mentions.map((mention) => ({
      ...mention,
      range: { ...mention.range },
    })),
  };
}

function buildDefaultComposerSession(
  defaults: ResolveComposerSessionInput["globalDefaults"],
): ComposerSession {
  const modelId = getDefaultModelId();
  return {
    input: "",
    mentions: [],
    selectedTextComments: [],
    selectedTextCommentEditor: undefined,
    attachments: [],
    modelId,
    provider: getDefaultProviderId(),
    reasoning: normalizeReasoningLevelForModel(modelId, getDefaultReasoningLevel()),
    interactionMode:
      defaults.interactionMode === INTERACTION_MODES.PLAN
        ? INTERACTION_MODES.PLAN
        : INTERACTION_MODES.BUILD,
    permissionMode: defaults.permissionMode,
    copilotAgent: null,
    contextWindow: null,
    thinking: null,
    codexFastMode: null,
  };
}

function buildSavedComposerSession(
  saved: ComposerDraft,
  threadSettings: ResolveComposerSessionInput["threadSettings"],
): ComposerSession {
  return {
    input: saved.input,
    mentions: saved.mentions ?? [],
    selectedTextComments: saved.selectedTextComments?.map((comment) => ({
      ...comment,
      source: { ...comment.source },
      mentions: comment.mentions.map((mention) => ({
        ...mention,
        range: { ...mention.range },
      })),
    })) ?? [],
    selectedTextCommentEditor: snapshotSelectedTextCommentEditor(saved.selectedTextCommentEditor),
    attachments: saved.attachments.map((attachment) => ({ ...attachment })),
    modelId: saved.modelId,
    provider: saved.provider ?? getDefaultProviderId(),
    reasoning: normalizeReasoningLevelForModel(saved.modelId, saved.reasoning),
    interactionMode: threadSettings.interactionMode,
    permissionMode: threadSettings.permissionMode,
    copilotAgent: threadSettings.copilotAgent,
    contextWindow: threadSettings.contextWindow,
    thinking: threadSettings.thinking,
    codexFastMode: resolveSavedCodexFastMode(saved.codexFastMode, threadSettings.codexFastMode),
  };
}

function resolveSavedCodexFastMode(
  savedValue: boolean | null | undefined,
  threadValue: boolean | null,
): boolean | null {
  return savedValue === undefined ? threadValue : savedValue;
}

function resolveInteractionMode(
  interactionMode: WorkspaceThread["interaction_mode"] | undefined,
  defaults: ResolveComposerSessionInput["globalDefaults"],
): InteractionMode {
  if (interactionMode === "plan") return INTERACTION_MODES.PLAN;
  if (interactionMode === "build") return INTERACTION_MODES.BUILD;
  return defaults.interactionMode === INTERACTION_MODES.PLAN
    ? INTERACTION_MODES.PLAN
    : INTERACTION_MODES.BUILD;
}

function buildThreadModelSession(
  threadRow: WorkspaceThread | undefined,
): Pick<ComposerSession, "modelId" | "provider" | "reasoning"> {
  const modelId = resolveThreadModelId(threadRow?.model, getDefaultModelId());
  const reasoning = threadRow?.reasoning_level
    ? (threadRow.reasoning_level as ReasoningLevel)
    : getDefaultReasoningLevel();

  return {
    modelId,
    provider: (threadRow?.provider as string | undefined) ?? getDefaultProviderId(),
    reasoning: normalizeReasoningLevelForModel(modelId, reasoning),
  };
}

function buildThreadOptionSession(
  threadRow: WorkspaceThread | undefined,
  globalDefaults: ResolveComposerSessionInput["globalDefaults"],
): Pick<ComposerSession, "interactionMode" | "permissionMode"> {
  return {
    interactionMode: resolveInteractionMode(threadRow?.interaction_mode, globalDefaults),
    permissionMode:
      (threadRow?.permission_mode as PermissionMode | null | undefined) ??
      globalDefaults.permissionMode,
  };
}

function buildThreadFlags(
  threadRow: WorkspaceThread | undefined,
): Pick<ComposerSession, "copilotAgent" | "contextWindow" | "thinking" | "codexFastMode"> {
  return {
    copilotAgent: threadRow?.copilot_agent ?? null,
    contextWindow: (threadRow?.context_window_mode as ContextWindowMode | null | undefined) ?? null,
    thinking: threadRow?.thinking ?? null,
    codexFastMode: threadRow?.codex_fast_mode ?? null,
  };
}

function buildThreadComposerSession(
  threadRow: WorkspaceThread | undefined,
  globalDefaults: ResolveComposerSessionInput["globalDefaults"],
): ComposerSession {
  return {
    input: "",
    mentions: [],
    selectedTextComments: [],
    selectedTextCommentEditor: undefined,
    attachments: [],
    ...buildThreadModelSession(threadRow),
    ...buildThreadOptionSession(threadRow, globalDefaults),
    ...buildThreadFlags(threadRow),
  };
}

/**
 * Resolve the composer session to install when entering a thread (or new-thread mode).
 * Pure function: no DOM, no store writes.
 */
export function resolveComposerSession(input: ResolveComposerSessionInput): ComposerSession {
  const { threadId, getDraft, threadRow, threadSettings, globalDefaults } = input;

  if (!threadId) return buildDefaultComposerSession(globalDefaults);

  const saved = getDraft(threadId);
  if (saved) return buildSavedComposerSession(saved, threadSettings);

  return buildThreadComposerSession(threadRow, globalDefaults);
}
