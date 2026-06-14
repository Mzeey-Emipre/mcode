import { describe, it, expect } from "vitest";
import { isGoalControlCommand } from "../goal-command";

describe("isGoalControlCommand", () => {
  it.each([
    ["/goal"],
    ["/goal "],
    ["  /goal  "],
    ["/goal clear"],
    ["/goal CLEAR"],
    ["/goal  clear  "],
    ["/goal reset"],
    ["/goal Reset"],
    ["/goal show"],
    ["/goal SHOW"],
  ])("recognises %j as a control-form command", (text) => {
    expect(isGoalControlCommand(text)).toBe(true);
  });

  it.each([
    ["/goal ship the feature"],
    ["/goal cleartheworld"], // not a control verb
    ["/goal reset everything"], // SET with leading 'reset'
    ["/goalclear"], // missing word boundary
    ["please /goal clear"], // only leading /goal is an app command
    ["goal clear"], // missing slash
    [""],
    ["just text"],
    ["/plan"],
  ])("returns false for %j", (text) => {
    expect(isGoalControlCommand(text)).toBe(false);
  });
});
