import { describe, expect, it, vi } from "vitest";
import { AgentEventType, type AgentEvent } from "@mcode/contracts";
import {
  ClaudeEventMapper,
  type ClaudeEventMapperCallbacks,
} from "../claude-event-mapper.js";

function createMapper(captureSdkSessionId = vi.fn(() => true)) {
  const events: AgentEvent[] = [];
  const callbacks: ClaudeEventMapperCallbacks = {
    emit: (event) => events.push(event),
    getSession: () => undefined,
    captureSdkSessionId,
    observeNativeGoalCommands: vi.fn(),
    applyNativeGoalCommandResult: vi.fn(),
    invalidateSdkSession: vi.fn(),
    markSessionPoisoned: vi.fn(),
    updateUsage: vi.fn(() => ({})),
    invalidateUsage: vi.fn(),
    resolveBillingMode: vi.fn(async () => "unknown"),
    isSessionStartHookSuppressed: vi.fn(() => false),
    clearSessionStartHookSuppression: vi.fn(),
  };
  return {
    events,
    captureSdkSessionId,
    mapper: new ClaudeEventMapper("mcode-test", "test", callbacks),
  };
}

describe("ClaudeEventMapper native dispatch", () => {
  it.each(["__proto__", "constructor", "toString"])(
    "ignores unsafe native type %s",
    async (type) => {
      const { events, mapper } = createMapper();

      await expect(mapper.map({ type })).resolves.toBe("none");

      expect(events).toEqual([]);
    },
  );

  it.each(["__proto__", "constructor", "toString"])(
    "treats unsafe system subtype %s as an unknown native event",
    async (subtype) => {
      const { events, mapper } = createMapper();

      await expect(mapper.map({ type: "system", subtype })).resolves.toBe(
        "none",
      );

      expect(events).toEqual([
        {
          type: AgentEventType.System,
          threadId: "test",
          subtype,
        },
      ]);
    },
  );

  it("rejects a whitespace SDK session identity", () => {
    const { events, captureSdkSessionId, mapper } = createMapper();

    mapper.captureSessionIdentity({ type: "system", session_id: " \t " }, true);

    expect(captureSdkSessionId).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });
});
