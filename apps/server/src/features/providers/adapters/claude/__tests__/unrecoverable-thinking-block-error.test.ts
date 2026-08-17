import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { isUnrecoverableThinkingBlockError } from "../claude-provider.js";

describe("isUnrecoverableThinkingBlockError", () => {
  it("matches the API 400 about unmodifiable thinking blocks", () => {
    const result =
      'API Error: 400 {"type":"error","error":{"type":"invalid_request_error",' +
      '"message":"messages.3.content.63: `thinking` or `redacted_thinking` blocks ' +
      'in the latest assistant message cannot be modified. These blocks must remain ' +
      'as they were in the original response."},"request_id":"req_011CbXbo4WBwX9JhUhPi1L6r"}';
    expect(isUnrecoverableThinkingBlockError(result)).toBe(true);
  });

  it("matches the redacted_thinking-only phrasing", () => {
    const result =
      "messages.5.content.2: `redacted_thinking` blocks in the latest assistant " +
      "message cannot be modified.";
    expect(isUnrecoverableThinkingBlockError(result)).toBe(true);
  });

  it("does not match the resume 'No conversation found' error", () => {
    expect(
      isUnrecoverableThinkingBlockError("No conversation found with session ID: abc"),
    ).toBe(false);
  });

  it("does not match an unrelated 400", () => {
    expect(
      isUnrecoverableThinkingBlockError(
        'API Error: 400 {"type":"invalid_request_error","message":"max_tokens too large"}',
      ),
    ).toBe(false);
  });

  it("does not match an empty or non-string payload", () => {
    expect(isUnrecoverableThinkingBlockError("")).toBe(false);
    expect(isUnrecoverableThinkingBlockError(undefined)).toBe(false);
  });
});
