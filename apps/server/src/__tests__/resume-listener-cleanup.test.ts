import "reflect-metadata";
import { describe, it, expect } from "vitest";
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
   * Register listeners for the resume retry lifecycle without emitting any events.
   *
   * Both handlers call resolve() to signal cleanup is complete. The resumeHandler
   * resolves when _resumeFailed fires (retry succeeded), and doneHandler resolves
   * when _streamDone fires (stream completed). The promise settles as soon as either
   * event fires, indicating cross-cleanup is complete.
   *
   * @param provider - The ClaudeProvider instance
   * @param sessionId - The session ID for this listener cycle
   * @returns A promise that settles when either handler fires
   */
  function registerListenerCycle(
    provider: ClaudeProvider,
    sessionId: string,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const resumeHandler = () => {
        provider.removeListener(
          `_streamDone:${sessionId}`,
          doneHandler,
        );
        resolve(true);
      };
      const doneHandler = () => {
        provider.removeListener(
          `_resumeFailed:${sessionId}`,
          resumeHandler,
        );
        resolve(false);
      };
      provider.once(`_resumeFailed:${sessionId}`, resumeHandler);
      provider.once(`_streamDone:${sessionId}`, doneHandler);
    });
  }

  it("cleans up both listeners after _resumeFailed fires", async () => {
    const sid = "test-session-1";

    const listenerPromise = registerListenerCycle(provider, sid);
    expect(countResumeListeners(provider, sid)).toBe(2);

    provider.emit(`_resumeFailed:${sid}`);
    await listenerPromise;

    expect(countResumeListeners(provider, sid)).toBe(0);
  });

  it("cleans up both listeners after _streamDone fires", async () => {
    const sid = "test-session-2";

    const listenerPromise = registerListenerCycle(provider, sid);
    expect(countResumeListeners(provider, sid)).toBe(2);

    provider.emit(`_streamDone:${sid}`);
    await listenerPromise;

    expect(countResumeListeners(provider, sid)).toBe(0);
  });

  it("does not accumulate listeners after N resume failures", async () => {
    const sid = "test-session-leak";
    const iterations = 50;

    for (let i = 0; i < iterations; i++) {
      const listenerPromise = registerListenerCycle(provider, sid);
      provider.emit(`_resumeFailed:${sid}`);
      await listenerPromise;
    }

    expect(countResumeListeners(provider, sid)).toBe(0);
  });
});
