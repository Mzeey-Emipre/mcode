import { describe, it, expect } from "vitest";
import {
  CURSOR_ACP_CONTINUE_AFTER_DISCONNECT_PROMPT,
  CURSOR_RATE_LIMIT_RETRY_JITTER_MS,
  buildCursorAcpContinueAfterDisconnectPrompt,
  computeCursorRateLimitBackoffMs,
  interruptibleDelay,
  isLikelyTransientCursorPromptFailure,
  looksLikeAcpConnectionClosed,
  looksLikeCursorRateLimit,
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

describe("looksLikeCursorRateLimit", () => {
  it("detects the minified ConnectError resource_exhausted shape", () => {
    expect(looksLikeCursorRateLimit("v: [resource_exhausted] Error")).toBe(true);
    expect(looksLikeCursorRateLimit("Error: [RESOURCE_EXHAUSTED] rate limited")).toBe(true);
  });

  it("treats rate limits as transient so the prompt loop retries them", () => {
    expect(isLikelyTransientCursorPromptFailure("v: [resource_exhausted] Error")).toBe(true);
  });

  it("ignores unrelated messages", () => {
    expect(looksLikeCursorRateLimit("Internal Server Error")).toBe(false);
    expect(looksLikeCursorRateLimit("resourceexhausted")).toBe(false);
  });
});

describe("computeCursorRateLimitBackoffMs", () => {
  it("adds zero jitter at the bottom of the random range", () => {
    expect(computeCursorRateLimitBackoffMs(3000, () => 0)).toBe(3000);
  });

  it("adds full jitter at the top of Math.random's [0, 1) range", () => {
    expect(computeCursorRateLimitBackoffMs(3000, () => 0.999999)).toBe(
      3000 + CURSOR_RATE_LIMIT_RETRY_JITTER_MS,
    );
  });

  it("never produces a negative delay from a misconfigured base", () => {
    expect(computeCursorRateLimitBackoffMs(-5000, () => 0)).toBe(0);
    expect(computeCursorRateLimitBackoffMs(Number.NaN, () => 0)).toBe(0);
  });

  it("floors a fractional base to whole milliseconds", () => {
    expect(computeCursorRateLimitBackoffMs(3000.9, () => 0)).toBe(3000);
  });
});

describe("interruptibleDelay", () => {
  it("resolves immediately when already aborted", async () => {
    let resolved = false;
    await interruptibleDelay(10_000, () => true).then(() => {
      resolved = true;
    });
    expect(resolved).toBe(true);
  });

  it("resolves immediately for a non-positive delay", async () => {
    await expect(interruptibleDelay(0, () => false)).resolves.toBeUndefined();
  });

  it("resolves once a short delay elapses", async () => {
    await expect(interruptibleDelay(5, () => false, 1)).resolves.toBeUndefined();
  });
});
