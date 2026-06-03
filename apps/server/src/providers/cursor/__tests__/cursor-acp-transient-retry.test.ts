import { describe, it, expect } from "vitest";
import {
  CURSOR_ACP_CONTINUE_AFTER_DISCONNECT_PROMPT,
  buildCursorAcpContinueAfterDisconnectPrompt,
  isLikelyTransientCursorPromptFailure,
  looksLikeAcpConnectionClosed,
  looksLikeUpstreamStreamCancel,
  shouldSuppressCursorPromptError,
} from "../cursor-acp-transient-retry.js";

describe("isLikelyTransientCursorPromptFailure", () => {
  it("detects opaque HTTP outages and timeouts", () => {
    expect(isLikelyTransientCursorPromptFailure("Internal Server Error")).toBe(true);
    expect(isLikelyTransientCursorPromptFailure('post failed with 503 Service Unavailable')).toBe(true);
    expect(isLikelyTransientCursorPromptFailure("fetch failed")).toBe(true);
    expect(isLikelyTransientCursorPromptFailure("ETIMEDOUT")).toBe(true);
    expect(isLikelyTransientCursorPromptFailure("ECONNRESET while reading")).toBe(true);
    expect(isLikelyTransientCursorPromptFailure("socket hang up")).toBe(true);
    expect(isLikelyTransientCursorPromptFailure("429 Too Many Requests")).toBe(true);
  });

  it("treats HTTP/2 stream cancel copy as transient for optional prompt retry", () => {
    expect(
      isLikelyTransientCursorPromptFailure(
        "Error: v: [canceled] http/2 stream closed with error code CANCEL (0x8)",
      ),
    ).toBe(true);
    expect(looksLikeUpstreamStreamCancel("[canceled] http/2 stream closed")).toBe(true);
  });

  it("treats ACP connection closed as transient for capped continue retry", () => {
    expect(isLikelyTransientCursorPromptFailure("ACP connection closed")).toBe(true);
    expect(looksLikeAcpConnectionClosed("ACP connection closed")).toBe(true);
    expect(looksLikeAcpConnectionClosed("Error: ACP connection closed")).toBe(true);
  });

  it("suppresses ACP disconnect errors after explicit Stop", () => {
    expect(
      shouldSuppressCursorPromptError("ACP connection closed", {
        pendingUserStopAbort: true,
      }),
    ).toBe(true);
    expect(
      shouldSuppressCursorPromptError("ACP connection closed", {
        pendingUserStopAbort: false,
      }),
    ).toBe(false);
  });

  it("exports a continue prompt for post-disconnect recovery", () => {
    expect(CURSOR_ACP_CONTINUE_AFTER_DISCONNECT_PROMPT.length).toBeGreaterThan(10);
  });

  it("appends the interrupted user message to the continue retry prompt", () => {
    const built = buildCursorAcpContinueAfterDisconnectPrompt("fix the login bug");
    expect(built).toContain(CURSOR_ACP_CONTINUE_AFTER_DISCONNECT_PROMPT);
    expect(built).toContain("Last message:");
    expect(built).toContain("fix the login bug");
  });

  it("returns false for likely permanent client errors", () => {
    expect(isLikelyTransientCursorPromptFailure("invalid_grant")).toBe(false);
    expect(isLikelyTransientCursorPromptFailure("ENOENT: open failed")).toBe(false);
    expect(isLikelyTransientCursorPromptFailure("Unauthorized")).toBe(false);
    expect(
      isLikelyTransientCursorPromptFailure('status CANCEL detected on stream :path "/rpc"'),
    ).toBe(false);
  });
});
