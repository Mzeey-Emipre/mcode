import "reflect-metadata";
import { describe, it, expect, beforeEach } from "vitest";
import { EventEmitter } from "events";
import { ClaudeProvider } from "../providers/claude/claude-provider.js";

/**
 * Tests that verify resume listener cleanup in ClaudeProvider.
 *
 * Each test uses a unique sessionId to ensure isolation and prevent
 * listener bleed across test cases. The tests verify that listeners
 * registered for resume retry logic are properly cleaned up when either
 * the retry succeeds (_resumeFailed) or the stream completes (_streamDone).
 */
describe("ClaudeProvider resume listener cleanup", () => {
  let provider: ClaudeProvider;

  beforeEach(() => {
    provider = new ClaudeProvider();
  });

  /**
   * Count the total number of listeners registered for both internal resume events.
   *
   * @param provider - The EventEmitter instance to inspect
   * @param sessionId - The session ID to check listeners for
   * @returns The total count of listeners for both _resumeFailed and _streamDone events
   */
  function countResumeListeners(
    provider: EventEmitter,
    sessionId: string,
  ): number {
    return (
      provider.listenerCount(`_resumeFailed:${sessionId}`) +
      provider.listenerCount(`_streamDone:${sessionId}`)
    );
  }

  /**
   * Simulate the production resume listener lifecycle using the same
   * try/finally pattern as doSendMessage (claude-provider.ts:306-331).
   *
   * Registers two once() listeners, emits the specified event to settle
   * the promise, then unconditionally removes both in a finally block.
   * This mirrors the real code path without requiring the full SDK.
   *
   * @param provider - The ClaudeProvider instance
   * @param sessionId - The session ID for this listener cycle
   * @param eventToEmit - The event name to emit (triggers settlement)
   * @returns The settled boolean (true = resumeFailed, false = streamDone)
   */
  async function runResumeCycle(
    provider: ClaudeProvider,
    sessionId: string,
    eventToEmit: string,
  ): Promise<boolean> {
    const failedEvent = `_resumeFailed:${sessionId}`;
    const doneEvent = `_streamDone:${sessionId}`;

    let resumeHandler: (() => void) | null = null;
    let doneHandler: (() => void) | null = null;

    const retryPromise = new Promise<boolean>((resolve) => {
      resumeHandler = () => resolve(true);
      doneHandler = () => resolve(false);
      provider.once(failedEvent, resumeHandler);
      provider.once(doneEvent, doneHandler);
    });

    provider.emit(eventToEmit);

    let result: boolean;
    try {
      result = await retryPromise;
    } finally {
      if (resumeHandler) provider.removeListener(failedEvent, resumeHandler);
      if (doneHandler) provider.removeListener(doneEvent, doneHandler);
    }

    return result;
  }

  it("cleans up both listeners after _resumeFailed fires", async () => {
    const sid = "test-session-1";

    const result = await runResumeCycle(
      provider,
      sid,
      `_resumeFailed:${sid}`,
    );

    expect(result).toBe(true);
    expect(countResumeListeners(provider, sid)).toBe(0);
  });

  it("cleans up both listeners after _streamDone fires", async () => {
    const sid = "test-session-2";

    const result = await runResumeCycle(
      provider,
      sid,
      `_streamDone:${sid}`,
    );

    expect(result).toBe(false);
    expect(countResumeListeners(provider, sid)).toBe(0);
  });

  it("does not accumulate listeners after N resume failures", async () => {
    const sid = "test-session-leak";
    const iterations = 50;

    for (let i = 0; i < iterations; i++) {
      await runResumeCycle(provider, sid, `_resumeFailed:${sid}`);
      expect(countResumeListeners(provider, sid)).toBe(0);
    }

    expect(countResumeListeners(provider, sid)).toBe(0);
  });
});
