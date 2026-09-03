import type { AttachmentMeta } from "@/transport";
import type { PreviewAnnotationBundle } from "@mcode/contracts";
import type { ComposerFormSubmission } from "../draft/useComposerFormController";
import type { ComposerSubmission } from "./composer-submission";

/** The stable data required to route a prepared Composer submit. */
export interface PreparedComposerSubmission {
  snapshot: ComposerFormSubmission;
  prepared: ComposerSubmission;
  trimmed: string;
  goalObjective?: string;
  attachmentMetas: AttachmentMeta[];
  currentAnnotations?: PreviewAnnotationBundle;
  previewAnnotations?: PreviewAnnotationBundle;
}
