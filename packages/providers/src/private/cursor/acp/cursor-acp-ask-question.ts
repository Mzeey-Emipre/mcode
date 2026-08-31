/**
 * @internal
 * Handles Cursor's blocking extension `cursor/ask_question`. Without a bespoke UI,
 * callers either auto-resolve with recommended safe picks or deliberately skip so
 * sessions keep protocol progress predictable.
 */

/** Summary payload forwarded to logging or optional synthetic timeline events. */
export interface CursorEchoAskQuestions {
  lines: string[];
  answers: Array<{ questionId: string; selectedOptionIds: string[] }>;
}

/** @internal Exported for deterministic unit tests around auto picks. */
export interface CursorAskQuestionOption {
  id?: string;
  label?: string;
  recommended?: boolean;
}

/** @internal */
export interface CursorAskQuestionItem {
  id?: string;
  prompt?: string;
  options?: CursorAskQuestionOption[];
  /** Cursor may omit this; treat missing as single-select. */
  allowMultiple?: boolean;
}

/** @internal */
export function pickCursorAskQuestionOptionIds(question: CursorAskQuestionItem): string[] {
  const opts = Array.isArray(question.options) ? question.options : [];
  const withIds = opts.filter((o) => typeof o.id === "string" && o.id.length > 0) as Array<
    CursorAskQuestionOption & { id: string }
  >;

  const recommended =
    withIds.find((o) => o.recommended === true) ??
    withIds.find((o) => /recommended/i.test(o.label ?? ""));
  if (recommended) return [recommended.id];

  const firstLabelled = withIds.find((o) => (o.label ?? "").trim().length > 0);
  if (firstLabelled) return [firstLabelled.id];

  if (withIds[0]) return [withIds[0].id];
  return [];
}

/**
 * Builds the JSON serializable object returned from the ACP `extMethod` handler.
 *
 * @param params - Raw JSON-RPC params from Cursor.
 * @param autoAnswer - When false, respond with `skipped` (legacy behavior).
 * @param onAutoSummary - Optional callback for structured logging or synthetic events.
 */
export function buildCursorAskQuestionExtResponse(
  params: Record<string, unknown>,
  autoAnswer: boolean,
  onAutoSummary?: (payload: CursorEchoAskQuestions) => void,
): Record<string, unknown> {
  if (!autoAnswer) return skippedCursorQuestionResponse("Mcode settings disabled auto answers for cursor/ask_question.");
  const rawQuestions = params.questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) return skippedCursorQuestionResponse("cursor/ask_question payload missing questions[]");
  const collected = collectCursorQuestionAnswers(rawQuestions);
  if (collected.kind === "skipped") return skippedCursorQuestionResponse(collected.reason);
  onAutoSummary?.(collected.payload);
  return { outcome: { outcome: "answered", answers: collected.payload.answers } };
}

function collectCursorQuestionAnswers(rawQuestions: unknown[]):
  | { kind: "answered"; payload: CursorEchoAskQuestions }
  | { kind: "skipped"; reason: string } {
  const answers: Array<{ questionId: string; selectedOptionIds: string[] }> = [];
  const lines: string[] = [];
  for (const question of rawQuestions) {
    const item = asCursorAskQuestionItem(question);
    if (!item) continue;
    const qid = cursorQuestionId(item, answers.length);
    const picks = pickCursorAskQuestionOptionIds(item);
    if (picks.length === 0) return { kind: "skipped", reason: `Question ${qid} had no selectable option ids` };
    answers.push({ questionId: qid, selectedOptionIds: picks });
    lines.push(cursorQuestionSummary(item, qid, picks));
  }
  if (answers.length === 0) return { kind: "skipped", reason: "cursor/ask_question had no usable question objects" };
  return { kind: "answered", payload: { lines, answers } };
}

function asCursorAskQuestionItem(value: unknown): CursorAskQuestionItem | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as CursorAskQuestionItem;
}

function cursorQuestionId(item: CursorAskQuestionItem, index: number): string {
  return typeof item.id === "string" && item.id.length > 0 ? item.id : `q${index}`;
}

function cursorQuestionSummary(item: CursorAskQuestionItem, questionId: string, picks: string[]): string {
  const prompt = typeof item.prompt === "string" ? item.prompt.trim() : "";
  return prompt ? `${prompt} → ${picks.join(", ")}` : `Question ${questionId} → ${picks.join(", ")}`;
}

function skippedCursorQuestionResponse(reason: string): Record<string, unknown> {
  return { outcome: { outcome: "skipped", reason } };
}
