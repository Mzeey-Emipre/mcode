import {
  isDiffAnnotationPayload,
  type PreviewAnnotationBundle,
} from "@mcode/contracts";

interface ComposerFeedbackCounts {
  readonly annotations: number;
  readonly comments: number;
}

function feedbackCounts(bundle: PreviewAnnotationBundle): ComposerFeedbackCounts {
  const comments = bundle.annotations.filter(isDiffAnnotationPayload).length;
  return {
    annotations: bundle.annotations.length - comments,
    comments,
  };
}

function countLabel(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function feedbackCountParts(bundle: PreviewAnnotationBundle): string[] {
  const counts = feedbackCounts(bundle);
  return [
    ...(counts.annotations > 0 ? [countLabel(counts.annotations, "annotation")] : []),
    ...(counts.comments > 0 ? [countLabel(counts.comments, "comment")] : []),
  ];
}

/** Formats the compact count shown for Preview annotations and code comments. */
export function composerFeedbackLabel(bundle: PreviewAnnotationBundle): string {
  return feedbackCountParts(bundle).join(" · ");
}

/** Formats an accessible count without relying on a visual separator. */
export function composerFeedbackAccessibleLabel(bundle: PreviewAnnotationBundle): string {
  return feedbackCountParts(bundle).join(" and ");
}
