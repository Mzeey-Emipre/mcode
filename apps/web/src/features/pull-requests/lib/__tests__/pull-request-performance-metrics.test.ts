import { describe, expect, it } from "vitest";
import { assessPullRequestLayoutOffsets } from "../pull-request-performance-metrics";

describe("pull request layout trace gate", () => {
  it("rejects two slow layouts inside one frame window", () => {
    expect(assessPullRequestLayoutOffsets([0, 5.7])).toEqual({
      passed: false,
      slowLayoutCount: 2,
      repeatedWithinFrame: true,
    });
  });

  it("accepts a later asynchronous worker paint", () => {
    expect(assessPullRequestLayoutOffsets([0, 56.5])).toEqual({
      passed: true,
      slowLayoutCount: 2,
      repeatedWithinFrame: false,
    });
  });

  it("rejects more than two separated slow layouts", () => {
    expect(assessPullRequestLayoutOffsets([0, 20, 40])).toEqual({
      passed: false,
      slowLayoutCount: 3,
      repeatedWithinFrame: false,
    });
  });
});
