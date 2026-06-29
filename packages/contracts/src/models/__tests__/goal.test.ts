import { describe, expect, it } from "vitest";
import {
  GoalLookupReasonSchema,
  GoalLookupResultSchema,
  GoalLookupSourceSchema,
  WS_METHODS,
  isGoalOpen,
  isGoalStatusOpen,
  type GoalState,
} from "../../index.js";

function goal(status: GoalState["status"]): GoalState {
  return {
    objective: "ship the feature",
    status,
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1,
    updatedAt: 1,
    source: "mcode",
    controls: {},
  };
}

describe("goal status helpers", () => {
  it("treats every non-complete goal status as open", () => {
    expect(isGoalStatusOpen("active")).toBe(true);
    expect(isGoalStatusOpen("paused")).toBe(true);
    expect(isGoalStatusOpen("blocked")).toBe(true);
    expect(isGoalStatusOpen("usageLimited")).toBe(true);
    expect(isGoalStatusOpen("budgetLimited")).toBe(true);
  });

  it("treats complete and missing goals as not open", () => {
    expect(isGoalStatusOpen("complete")).toBe(false);
    expect(isGoalOpen(goal("complete"))).toBe(false);
    expect(isGoalOpen(null)).toBe(false);
    expect(isGoalOpen(undefined)).toBe(false);
  });

  it("narrows open goal states", () => {
    const current = goal("active");

    if (!isGoalOpen(current)) {
      throw new Error("expected an open goal");
    }

    expect(current.objective).toBe("ship the feature");
  });
});

describe("goal lookup contract", () => {
  it("accepts the exact lookup source and reason vocabularies", () => {
    expect(GoalLookupSourceSchema().options).toEqual([
      "codex-native",
      "codex-cache",
      "claude-wrapper",
      "unsupported",
    ]);
    expect(GoalLookupReasonSchema().options).toEqual([
      "not-materialized",
      "closed",
      "missing",
      "unsupported-provider",
    ]);
  });

  it("registers thread goal app RPC params and result validation", () => {
    const getMethod = WS_METHODS()["thread.goal.get"];
    const clearMethod = WS_METHODS()["thread.goal.clear"];

    expect(getMethod.params.parse({ threadId: "thread-1" })).toEqual({ threadId: "thread-1" });
    expect(clearMethod.params.parse({ threadId: "thread-1" })).toEqual({ threadId: "thread-1" });
    expect(clearMethod.result.parse({
      goal: null,
      authoritative: true,
      source: "unsupported",
      reason: "unsupported-provider",
    })).toEqual({
      goal: null,
      authoritative: true,
      source: "unsupported",
      reason: "unsupported-provider",
    });
    expect(() => GoalLookupResultSchema().parse({
      goal: null,
      authoritative: true,
      source: "cursor-cache",
    })).toThrow();
  });
});
