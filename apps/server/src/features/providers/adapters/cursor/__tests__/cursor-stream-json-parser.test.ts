/**
 * Tests for the cursor stream-json NDJSON parser.
 *
 * The parser turns the raw bytes from cursor-agent --print's stdout into a
 * sequence of typed CursorStreamEvent objects. It must:
 *   - split on LF (handle CRLF gracefully)
 *   - buffer partial lines across data chunks
 *   - skip blank lines
 *   - skip lines that don't parse as JSON or that lack a string `type`
 *   - never throw on malformed input (cursor-agent occasionally interleaves
 *     diagnostic prose on stdout when something goes wrong)
 */

import { describe, it, expect } from "vitest";
import { CursorStreamJsonParser } from "../cursor-stream-json-parser.js";

describe("CursorStreamJsonParser", () => {
  it("emits one event per complete line", () => {
    const parser = new CursorStreamJsonParser();
    const events = parser.feed(
      `{"type":"system","subtype":"init","session_id":"abc"}\n{"type":"result","subtype":"success"}\n`,
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "system", subtype: "init", session_id: "abc" });
    expect(events[1]).toEqual({ type: "result", subtype: "success" });
  });

  it("buffers a partial trailing line until the next chunk completes it", () => {
    const parser = new CursorStreamJsonParser();
    const a = parser.feed(`{"type":"assistant","mess`);
    expect(a).toEqual([]);
    const b = parser.feed(`age":{"role":"assistant"}}\n`);
    expect(b).toHaveLength(1);
    expect(b[0]).toEqual({ type: "assistant", message: { role: "assistant" } });
  });

  it("handles CRLF line endings", () => {
    const parser = new CursorStreamJsonParser();
    const events = parser.feed(
      `{"type":"system","subtype":"init"}\r\n{"type":"result","subtype":"success"}\r\n`,
    );
    expect(events).toHaveLength(2);
  });

  it("skips blank lines", () => {
    const parser = new CursorStreamJsonParser();
    const events = parser.feed(`\n\n{"type":"result","subtype":"success"}\n\n`);
    expect(events).toHaveLength(1);
  });

  it("skips unparseable lines without throwing", () => {
    const parser = new CursorStreamJsonParser();
    const events = parser.feed(
      `not json at all\n{"type":"result","subtype":"success"}\nalso not json\n`,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "result", subtype: "success" });
  });

  it("skips lines that parse but lack a string type field", () => {
    const parser = new CursorStreamJsonParser();
    const events = parser.feed(
      `{"missing":"type"}\n{"type":42}\n{"type":"system","subtype":"init"}\n`,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "system", subtype: "init" });
  });

  it("flush returns the trailing buffered line when the stream ends without a newline", () => {
    const parser = new CursorStreamJsonParser();
    expect(parser.feed(`{"type":"result","subtype":"success"}`)).toEqual([]);
    const flushed = parser.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toEqual({ type: "result", subtype: "success" });
  });

  it("flush returns [] when there is no trailing buffered line", () => {
    const parser = new CursorStreamJsonParser();
    parser.feed(`{"type":"result"}\n`);
    expect(parser.flush()).toEqual([]);
  });
});
