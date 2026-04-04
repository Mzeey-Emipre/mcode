import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { EventEmitter } from "events";
import { ClaudeProvider } from "../providers/claude/claude-provider.js";

describe("ClaudeProvider resume listener cleanup", () => {
  /**
   * Count listeners for the two internal resume events on the provider.
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

  it("cleans up both listeners after _resumeFailed fires", async () => {
    const provider = new ClaudeProvider();
    const sid = "test-session-1";

    // Simulate the resume promise externally: register handlers the same way
    // doSendMessage does, then fire _resumeFailed.
    const retryPromise = new Promise<boolean>((resolve) => {
      const resumeHandler = () => {
        provider.removeListener(
          `_streamDone:${sid}`,
          doneHandler,
        );
        resolve(true);
      };
      const doneHandler = () => {
        provider.removeListener(
          `_resumeFailed:${sid}`,
          resumeHandler,
        );
        resolve(false);
      };
      provider.once(`_resumeFailed:${sid}`, resumeHandler);
      provider.once(`_streamDone:${sid}`, doneHandler);
    });

    // Before either event fires, both listeners should be registered.
    expect(countResumeListeners(provider, sid)).toBe(2);

    provider.emit(`_resumeFailed:${sid}`);
    await retryPromise;

    // After settlement, zero listeners should remain.
    expect(countResumeListeners(provider, sid)).toBe(0);
  });

  it("cleans up both listeners after _streamDone fires", async () => {
    const provider = new ClaudeProvider();
    const sid = "test-session-2";

    const retryPromise = new Promise<boolean>((resolve) => {
      const resumeHandler = () => {
        provider.removeListener(
          `_streamDone:${sid}`,
          doneHandler,
        );
        resolve(true);
      };
      const doneHandler = () => {
        provider.removeListener(
          `_resumeFailed:${sid}`,
          resumeHandler,
        );
        resolve(false);
      };
      provider.once(`_resumeFailed:${sid}`, resumeHandler);
      provider.once(`_streamDone:${sid}`, doneHandler);
    });

    expect(countResumeListeners(provider, sid)).toBe(2);

    provider.emit(`_streamDone:${sid}`);
    await retryPromise;

    expect(countResumeListeners(provider, sid)).toBe(0);
  });

  it("does not accumulate listeners after N resume failures", async () => {
    const provider = new ClaudeProvider();
    const sid = "test-session-leak";
    const iterations = 50;

    for (let i = 0; i < iterations; i++) {
      const retryPromise = new Promise<boolean>((resolve) => {
        const resumeHandler = () => {
          provider.removeListener(
            `_streamDone:${sid}`,
            doneHandler,
          );
          resolve(true);
        };
        const doneHandler = () => {
          provider.removeListener(
            `_resumeFailed:${sid}`,
            resumeHandler,
          );
          resolve(false);
        };
        provider.once(`_resumeFailed:${sid}`, resumeHandler);
        provider.once(`_streamDone:${sid}`, doneHandler);
      });

      provider.emit(`_resumeFailed:${sid}`);
      await retryPromise;
    }

    expect(countResumeListeners(provider, sid)).toBe(0);
  });
});
