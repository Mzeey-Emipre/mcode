import { describe, expect, it } from "vitest";
import { generatedImagePathFromCodexItem } from "../../private/codex/codex-provider.js";

describe("generatedImagePathFromCodexItem", () => {
  it("reads savedPath from completed imageGeneration items", () => {
    expect(generatedImagePathFromCodexItem({
      type: "imageGeneration",
      id: "img-1",
      status: "completed",
      result: "saved",
      savedPath: "C:\\work\\generated.png",
    })).toBe("C:\\work\\generated.png");
  });

  it("ignores failed imageGeneration items", () => {
    expect(generatedImagePathFromCodexItem({
      type: "imageGeneration",
      id: "img-1",
      status: "failed",
      result: "failed",
      savedPath: "C:\\work\\generated.png",
    })).toBeNull();
  });

  it("does not parse model text as a filesystem path", () => {
    expect(generatedImagePathFromCodexItem({
      type: "imageGeneration",
      id: "img-1",
      status: "completed",
      result: "Saved to C:\\work\\generated.png",
    })).toBeNull();
  });
});
