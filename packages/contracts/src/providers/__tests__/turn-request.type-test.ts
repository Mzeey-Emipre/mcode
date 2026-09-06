import { describe, it, expect } from "vitest";
import type { TurnRequest } from "../interfaces.js";

/**
 * These assertions are compile-time first: if the discriminated `providerOptions`
 * bag stops walling knobs by Provider, the file fails to typecheck. The runtime
 * bodies are trivial so Vitest registers the file as a passing suite.
 */
describe("TurnRequest providerOptions discrimination", () => {
  it("accepts Claude knobs on a claude request", () => {
    const req: TurnRequest<"claude"> = {
      turnId: "turn-1",
      turnExecutionId: "00000000-0000-4000-8000-000000000001",
      sessionId: "mcode-t1",
      workspaceId: "workspace-1",
      threadId: "t1",
      message: "hi",
      cwd: "/tmp",
      model: "claude-sonnet-4-6",
      permissionMode: "full",
      approvalReviewMode: "manual",
      interactionMode: "build",
      providerOptions: { contextWindowMode: "1m", thinking: true },
    };
    expect(req.providerOptions.contextWindowMode).toBe("1m");
  });

  it("requires an empty bag for knob-less providers", () => {
    const req: TurnRequest<"cursor"> = {
      turnId: "turn-2",
      turnExecutionId: "00000000-0000-4000-8000-000000000002",
      sessionId: "mcode-t2",
      workspaceId: "workspace-1",
      threadId: "t2",
      message: "hi",
      cwd: "/tmp",
      model: "cursor-default",
      permissionMode: "supervised",
      approvalReviewMode: "manual",
      interactionMode: "plan",
      providerOptions: {},
    };
    expect(req.providerOptions).toEqual({});
  });

  it("walls off cross-provider knobs (negative case via @ts-expect-error)", () => {
    const bad: TurnRequest<"claude"> = {
      turnId: "turn-3",
      turnExecutionId: "00000000-0000-4000-8000-000000000003",
      sessionId: "mcode-t3",
      workspaceId: "workspace-1",
      threadId: "t3",
      message: "hi",
      cwd: "/tmp",
      model: "claude-sonnet-4-6",
      permissionMode: "full",
      approvalReviewMode: "manual",
      interactionMode: "build",
      // @ts-expect-error fastMode is a Codex knob, not valid on a Claude request
      providerOptions: { fastMode: true },
    };
    void bad;
    expect(true).toBe(true);
  });
});
