import { describe, expect, it } from "vitest";
import { CursorProvider } from "../cursor-provider.js";

describe("CursorProvider usage limits", () => {
  it("does not expose team or admin usage through provider.getUsage", () => {
    expect("getUsage" in CursorProvider.prototype).toBe(false);
  });
});
