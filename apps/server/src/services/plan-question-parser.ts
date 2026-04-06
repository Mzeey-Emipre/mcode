import { z } from "zod";
import { PlanQuestionSchema } from "@mcode/contracts";
import { logger } from "@mcode/shared";

const OPEN_MARKER = "```plan-questions";
const CLOSE_MARKER = "```";

/** Maximum number of questions allowed in a batch. */
const MAX_QUESTIONS = 15;

/**
 * Streaming parser that scans accumulated textDelta output for a fenced
 * plan-questions block and extracts structured questions from it.
 *
 * Feed text deltas via `feed()`. Returns the parsed question array the first
 * time a valid, complete block is found. Returns null on every subsequent call.
 */
export class PlanQuestionParser {
  private buffer = "";
  private _hasQuestions = false;
  /** Buffer offset past which to start scanning on the next feed() call.
   * Advances past failed blocks so the same malformed content is never retried. */
  private _scanFrom = 0;

  /**
   * Append a streaming text delta to the internal buffer and attempt to
   * extract a plan-questions block. Returns the parsed question array if a
   * valid block is found for the first time; null otherwise.
   */
  feed(delta: string): z.infer<typeof PlanQuestionSchema>[] | null {
    if (this._hasQuestions) return null;

    this.buffer += delta;

    const openIdx = this.buffer.indexOf(OPEN_MARKER, this._scanFrom);
    if (openIdx === -1) return null;

    const jsonStart = openIdx + OPEN_MARKER.length;
    // The close marker must appear AFTER the JSON content, not at jsonStart
    const closeIdx = this.buffer.indexOf(CLOSE_MARKER, jsonStart + 1);
    if (closeIdx === -1) return null;

    // Advance scan past this block regardless of parse outcome so the
    // same block is never retried if it fails.
    this._scanFrom = closeIdx + CLOSE_MARKER.length;

    const jsonStr = this.buffer.slice(jsonStart, closeIdx).trim();

    let raw: unknown;
    try {
      raw = JSON.parse(jsonStr);
    } catch {
      logger.warn("plan-question-parser: malformed JSON in plan-questions block");
      return null;
    }

    if (!Array.isArray(raw) || raw.length === 0) return null;

    if (raw.length > MAX_QUESTIONS) {
      logger.warn("plan-question-parser: too many questions, rejecting batch", {
        count: raw.length,
        max: MAX_QUESTIONS,
      });
      return null;
    }

    const parsed = z.array(PlanQuestionSchema).safeParse(raw);
    if (!parsed.success) {
      logger.warn("plan-question-parser: schema validation failed", {
        error: parsed.error.message,
      });
      return null;
    }

    this._hasQuestions = true;
    return parsed.data;
  }

  /** True once a valid question batch has been successfully extracted. */
  get hasQuestions(): boolean {
    return this._hasQuestions;
  }
}
