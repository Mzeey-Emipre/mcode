import type { PendingAttachment } from "@/components/chat/AttachmentPreview";
import type { ComposerDraft } from "@/stores/composerDraftStore";
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
    attachments: draft.attachments.map((attachment) => ({ ...attachment })),
  };
}

/**
 * Resolve the composer session to install when entering a thread (or new-thread mode).
 * Pure function: no DOM, no store writes.
 */
export function resolveComposerSession(input: ResolveComposerSessionInput): ComposerSession {
  const { threadId, getDraft, threadRow, threadSettings, globalDefaults } = input;

  if (!threadId) {
    const modelId = getDefaultModelId();
    return {
      input: "",
      mentions: [],
      selectedTextComments: [],
      attachments: [],
      modelId,
      provider: getDefaultProviderId(),
      reasoning: normalizeReasoningLevelForModel(modelId, getDefaultReasoningLevel()),
      interactionMode:
        globalDefaults.interactionMode === INTERACTION_MODES.PLAN
          ? INTERACTION_MODES.PLAN
          : INTERACTION_MODES.BUILD,
      permissionMode: globalDefaults.permissionMode,
      copilotAgent: null,
      contextWindow: null,
      thinking: null,
      codexFastMode: null,
    };
  }

  const saved = getDraft(threadId);
  if (saved) {
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
      attachments: saved.attachments.map((attachment) => ({ ...attachment })),
      modelId: saved.modelId,
      provider: saved.provider ?? getDefaultProviderId(),
      reasoning: normalizeReasoningLevelForModel(saved.modelId, saved.reasoning),
      interactionMode: threadSettings.interactionMode,
      permissionMode: threadSettings.permissionMode,
      copilotAgent: threadSettings.copilotAgent,
      contextWindow: threadSettings.contextWindow,
      thinking: threadSettings.thinking,
      codexFastMode:
        saved.codexFastMode !== undefined
          ? saved.codexFastMode
          : threadSettings.codexFastMode,
    };
  }

  const resolvedModelId = resolveThreadModelId(threadRow?.model, getDefaultModelId());
  return {
    input: "",
    mentions: [],
    selectedTextComments: [],
    attachments: [],
    modelId: resolvedModelId,
    provider: (threadRow?.provider as string | undefined) ?? getDefaultProviderId(),
    reasoning: normalizeReasoningLevelForModel(
      resolvedModelId,
      threadRow?.reasoning_level
        ? (threadRow.reasoning_level as ReasoningLevel)
        : getDefaultReasoningLevel(),
    ),
    interactionMode:
      threadRow?.interaction_mode === "plan"
        ? INTERACTION_MODES.PLAN
        : threadRow?.interaction_mode === "build"
          ? INTERACTION_MODES.BUILD
          : globalDefaults.interactionMode === INTERACTION_MODES.PLAN
            ? INTERACTION_MODES.PLAN
            : INTERACTION_MODES.BUILD,
    permissionMode:
      (threadRow?.permission_mode as PermissionMode | null | undefined) ??
      globalDefaults.permissionMode,
    copilotAgent: threadRow?.copilot_agent ?? null,
    contextWindow: (threadRow?.context_window_mode as ContextWindowMode | null | undefined) ?? null,
    thinking: threadRow?.thinking ?? null,
    codexFastMode: threadRow?.codex_fast_mode ?? null,
  };
}
