import { describe, expect, it } from "vitest";
import { parseClaudeGoalCommandResult } from "../claude-goal-command-parser.js";

const zeroTurnResult = { type: "result", num_turns: 0 };

describe("parseClaudeGoalCommandResult", () => {
  it("accepts observed zero-turn native goal responses", () => {
    expect(parseClaudeGoalCommandResult("Goal active: say hi (not yet evaluated)", zeroTurnResult)).toEqual({
      kind: "active",
      objective: "say hi",
    });
    expect(parseClaudeGoalCommandResult("No goal set. Usage: `/goal <condition>`", zeroTurnResult)).toEqual({
      kind: "empty",
    });
    expect(parseClaudeGoalCommandResult("No goal set", zeroTurnResult)).toEqual({
      kind: "empty",
    });
    expect(parseClaudeGoalCommandResult("Goal cleared: wait until user says mcode-stop-probe", zeroTurnResult)).toEqual({
      kind: "cleared",
      objective: "wait until user says mcode-stop-probe",
    });
    expect(parseClaudeGoalCommandResult("/goal isn't available in this environment.", zeroTurnResult)).toEqual({
      kind: "unavailable",
    });
  });

  it("rejects missing or nonzero result records", () => {
    for (const text of [
      "Goal active: say hi (not yet evaluated)",
      "No goal set",
      "Goal cleared: wait until user says mcode-stop-probe",
      "/goal isn't available in this environment.",
    ]) {
      expect(parseClaudeGoalCommandResult(text, { type: "result", num_turns: 1 })).toBeNull();
      expect(parseClaudeGoalCommandResult(text, null)).toBeNull();
    }
  });

  it("rejects ordinary assistant and Stop-hook feedback text", () => {
    expect(parseClaudeGoalCommandResult("I set a goal for you.", zeroTurnResult)).toBeNull();
    expect(parseClaudeGoalCommandResult(
      'Goal not yet met: "say hi". Continue working until the goal is satisfied.',
      zeroTurnResult,
    )).toBeNull();
  });
});
