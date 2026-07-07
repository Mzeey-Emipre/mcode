import {
  PreviewAnnotationBundleSchema,
  type PreviewAnnotationBundle,
} from "@mcode/contracts";

/** Start marker for the hidden Preview Annotation bundle fence. */
export const ANNOTATION_FENCE_START = "<!-- mcode-preview-annotations:v1";
/** End marker for the hidden Preview Annotation bundle fence. */
export const ANNOTATION_FENCE_END = "mcode-preview-annotations:end -->";

/**
 * Appends a machine-readable Preview Annotation bundle to outbound agent content.
 */
export function appendPreviewAnnotationFence(
  content: string,
  bundle: PreviewAnnotationBundle | undefined,
): string {
  if (!bundle || bundle.annotations.length === 0) return content;
  const parsed = PreviewAnnotationBundleSchema().parse(bundle);
  const json = JSON.stringify(parsed);
  return `${content.trim()}\n\n${ANNOTATION_FENCE_START}\n${json}\n${ANNOTATION_FENCE_END}`.trim();
}

/**
 * Removes the hidden Preview Annotation bundle fence from displayable message content.
 */
export function stripPreviewAnnotationFence(content: string): string {
  const start = content.indexOf(ANNOTATION_FENCE_START);
  if (start === -1) return content;
  const end = content.indexOf(ANNOTATION_FENCE_END, start);
  if (end === -1) return content.slice(0, start).trimEnd();
  return `${content.slice(0, start)}${content.slice(end + ANNOTATION_FENCE_END.length)}`.trim();
}
