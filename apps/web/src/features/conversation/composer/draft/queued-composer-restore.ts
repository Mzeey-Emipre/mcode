import type { PendingAttachment } from "@/components/chat/AttachmentPreview";
import { isVirtualBrowserContextAttachment } from "@mcode/contracts";
import { stripPreviewAnnotationFence } from "@/features/preview/capture/preview-annotation-append";
import type { QueuedMessage } from "@/stores/queueStore";
import type { ComposerAgentSelection } from "./composer-selection-state";

/** Restored Composer values that were serialized in one queued message. */
export interface QueuedComposerRestoreState {
  text: string;
  mentions: QueuedMessage["mentions"];
  attachments: PendingAttachment[];
  selection: Partial<ComposerAgentSelection>;
  goalPending: boolean;
}

function restoreQueuedAttachments(attachments: QueuedMessage["attachments"]): PendingAttachment[] {
  return attachments.map((attachment) => ({
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    previewUrl: "",
    filePath: attachment.sourcePath || null,
    contextOnly: isVirtualBrowserContextAttachment(attachment.mimeType),
  }));
}

function restoreQueuedSelection(message: QueuedMessage): Partial<ComposerAgentSelection> {
  return {
    ...(message.model ? { modelId: message.model } : {}),
    ...(message.provider ? { provider: message.provider } : {}),
    ...(message.reasoningLevel ? { reasoning: message.reasoningLevel } : {}),
    ...(message.orchestrationMode ? { orchestrationMode: message.orchestrationMode } : {}),
    ...(message.permissionMode ? { permissionMode: message.permissionMode } : {}),
    copilotAgent: message.copilotAgent ?? null,
    contextWindow: message.contextWindow ?? null,
    thinking: message.thinking ?? null,
    codexFastMode: message.codexFastMode ?? null,
  };
}

/** Transforms one queued message into the draft values that the Composer can restore. */
export function createQueuedComposerRestoreState(message: QueuedMessage): QueuedComposerRestoreState {
  return {
    text: stripPreviewAnnotationFence(message.displayContent || message.content),
    mentions: message.mentions ?? [],
    attachments: restoreQueuedAttachments(message.attachments),
    selection: restoreQueuedSelection(message),
    goalPending: message.goalObjective !== undefined,
  };
}
