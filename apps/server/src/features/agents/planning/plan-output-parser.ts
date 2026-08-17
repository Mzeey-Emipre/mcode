import { PlanOutputSchema } from "@mcode/contracts";
import type { PlanOutput } from "@mcode/contracts";
import { logger } from "@mcode/shared";

const OPEN_MARKER = "```plan-output";
const CLOSE_MARKER = "```";

/**
 * Streaming parser that extracts structured plan data from
 * ```plan-output fenced blocks in agent text deltas.
 *
 * Mirrors PlanQuestionParser. Call feed() with each text delta;
 * returns the parsed PlanOutput on the first valid block, then
 * returns null for all subsequent calls.
 */
export class PlanOutputParser {
  private buffer = "";
  private _hasPlan = false;
  /** Buffer offset past which to start scanning on the next feed() call.
   * Advances past failed blocks so the same malformed content is never retried. */
  private _scanFrom = 0;

  /**
   * Append a streaming text delta to the internal buffer and attempt to
   * extract a plan-output block. Returns the parsed PlanOutput if a
   * valid block is found for the first time; null otherwise.
   */
  feed(delta: string): PlanOutput | null {
    if (this._hasPlan) return null;

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
      logger.warn("plan-output-parser: malformed JSON in plan-output block");
      return null;
    }

    const parsed = PlanOutputSchema().safeParse(raw);
    if (!parsed.success) {
      logger.warn("plan-output-parser: schema validation failed", {
        errors: parsed.error.issues.map((i) => i.message),
      });
      return null;
    }

    this._hasPlan = true;
    return parsed.data;
  }

  /** Whether a valid plan has been extracted. */
  get hasPlan(): boolean {
    return this._hasPlan;
  }
}
