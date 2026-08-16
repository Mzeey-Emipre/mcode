import "reflect-metadata";
import { describe, expect, it } from "vitest";
import * as handoff from "../index";

describe("handoff feature boundary", () => {
  it("exposes only the composition-root handoff symbols", () => {
    expect(Object.keys(handoff).sort()).toStrictEqual([
      "CleanForker",
      "HandoffCheckoutService",
      "HandoffCoordinator",
      "HandoffPipelineService",
      "HandoffStorage",
    ]);
  });
});
