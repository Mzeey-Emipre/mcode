import type { QueuedMessage } from "@/stores/queueStore";
import {
  serializeQueuedComposerForm,
  type QueuedComposerSerializationInput,
} from "./queued-composer-serialization";

/** Inputs that create a queue payload from the current Composer form. */
export type CreateQueuedComposerPayloadOptions = QueuedComposerSerializationInput;

/** Creates a durable queue payload without clearing or mutating the Composer form. */
export function createQueuedComposerPayload({
  attachments,
  input,
  mentions,
  previewAnnotations,
  selection,
  goalPending,
}: CreateQueuedComposerPayloadOptions): Omit<QueuedMessage, "id" | "queuedAt"> {
  return serializeQueuedComposerForm({
    attachments,
    input,
    mentions,
    previewAnnotations,
    selection,
    goalPending,
  });
}
