import type { SelectedTextComment } from "@mcode/contracts";

/** Renumbers saved comments after a direct or aggregate draft transition. */
export function renumberSelectedTextComments(
  comments: readonly SelectedTextComment[],
): SelectedTextComment[] {
  return comments.map((comment, index) => ({ ...comment, displayNumber: index + 1 }));
}

/** Appends a new saved comment or updates an existing one without changing its display number. */
export function saveSelectedTextComment(
  comments: readonly SelectedTextComment[],
  comment: SelectedTextComment,
): SelectedTextComment[] {
  const index = comments.findIndex((candidate) => candidate.id === comment.id);
  if (index < 0) {
    return [...comments, { ...comment, displayNumber: comments.length + 1 }];
  }
  return comments.map((candidate, candidateIndex) =>
    candidateIndex === index ? { ...comment, displayNumber: candidate.displayNumber } : candidate,
  );
}

/** Removes one saved comment and renumbers the survivors. */
export function removeSelectedTextComment(
  comments: readonly SelectedTextComment[],
  commentId: string,
): SelectedTextComment[] {
  return renumberSelectedTextComments(comments.filter((comment) => comment.id !== commentId));
}
