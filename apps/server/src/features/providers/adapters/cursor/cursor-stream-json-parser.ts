/**
 * Lenient NDJSON parser for cursor-agent --print's stream-json output.
 *
 * Each newline-delimited line is parsed as JSON; lines that fail to parse,
 * or that lack a string `type` discriminator, are silently dropped — cursor
 * occasionally interleaves diagnostic prose (auth errors, deprecation
 * warnings) on stdout when something goes wrong, and a strict parser would
 * tear down the turn for noise we want to log and skip.
 *
 * Partial trailing lines (no terminating LF) are buffered until the next
 * `feed` call completes them. Call `flush()` once the underlying stdout
 * stream has emitted `end` to drain any buffered final line.
 */

import { logger } from "@mcode/shared";
import type { CursorStreamEvent } from "./cursor-stream-json-types.js";

export class CursorStreamJsonParser {
  private buffer = "";

  /**
   * Append a chunk of stdout bytes (already decoded to a string) and return
   * any complete events the chunk produced.
   */
  feed(chunk: string): CursorStreamEvent[] {
    this.buffer += chunk;
    return this.drainCompleteLines();
  }

  /**
   * Flush any single buffered line that was missing its terminating
   * newline. Call after the underlying stream has ended.
   */
  flush(): CursorStreamEvent[] {
    if (!this.buffer) return [];
    const tail = this.buffer;
    this.buffer = "";
    const event = parseLine(tail);
    return event ? [event] : [];
  }

  private drainCompleteLines(): CursorStreamEvent[] {
    const events: CursorStreamEvent[] = [];
    let newlineIdx = this.buffer.indexOf("\n");
    while (newlineIdx >= 0) {
      const line = this.buffer.slice(0, newlineIdx);
      this.buffer = this.buffer.slice(newlineIdx + 1);
      const event = parseLine(line);
      if (event) events.push(event);
      newlineIdx = this.buffer.indexOf("\n");
    }
    return events;
  }
}

/**
 * Parse a single line; returns null for blank, malformed, or untyped lines.
 * Strips a trailing CR so CRLF input is handled cleanly.
 */
function parseLine(rawLine: string): CursorStreamEvent | null {
  const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
  if (!line.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    logger.debug("Cursor stream-json: dropping unparseable line", {
      preview: line.slice(0, 200),
    });
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.type !== "string") return null;
  return obj as CursorStreamEvent;
}
