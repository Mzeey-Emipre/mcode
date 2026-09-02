import { describe, expect, it } from "vitest";
import {
  THREAD_STARTUP_TRANSCRIPT_ENTRY_MAX_CHARS,
  ThreadStartupSchema,
} from "../thread-startup.js";

const startupId = "00000000-0000-4000-8000-000000000001";

function directStartup() {
  return {
    startupId,
    workspaceId: "workspace-1",
    kind: "direct" as const,
    state: "pending" as const,
    phase: "thread" as const,
    steps: [
      { phase: "thread" as const, state: "pending" as const },
      { phase: "agent" as const, state: "pending" as const },
    ],
    transcript: [],
    cancellation: "none" as const,
    revision: 1,
    createdAt: "2026-09-02T10:00:00.000Z",
    updatedAt: "2026-09-02T10:00:00.000Z",
  };
}

describe("ThreadStartupSchema", () => {
  it("rejects a completed state before its ordered final phase", () => {
    expect(ThreadStartupSchema().safeParse({
      ...directStartup(),
      state: "completed",
      steps: [
        { phase: "thread", state: "completed" },
        { phase: "agent", state: "pending" },
      ],
    }).success).toBe(false);
  });

  it("rejects output larger than the retained entry bound", () => {
    expect(ThreadStartupSchema().safeParse({
      ...directStartup(),
      transcript: [{
        phase: "thread",
        content: "x".repeat(THREAD_STARTUP_TRANSCRIPT_ENTRY_MAX_CHARS + 1),
        createdAt: "2026-09-02T10:00:00.000Z",
      }],
    }).success).toBe(false);
  });
});
