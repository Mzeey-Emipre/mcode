import {
  PreviewAnnotationBundleSchema,
  type PreviewAnnotationBundle,
} from "@mcode/contracts";

const ANNOTATION_FENCE_START = "<!-- mcode-preview-annotations:v1";
const ANNOTATION_FENCE_END = "mcode-preview-annotations:end -->";

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
