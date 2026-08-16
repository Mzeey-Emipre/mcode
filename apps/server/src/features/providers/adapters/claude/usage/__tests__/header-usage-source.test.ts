import { describe, expect, it } from "vitest";
import { AnthropicHeaderUsageSource } from "../header-usage-source.js";

describe("AnthropicHeaderUsageSource", () => {
  it("has the expected id", () => {
    expect(new AnthropicHeaderUsageSource().id).toBe("claude.headers");
  });

  it("reports unavailable until headers are observed", async () => {
    const source = new AnthropicHeaderUsageSource();
    expect(await source.isAvailable()).toBe(false);
  });

  it("returns null until headers are observed", async () => {
    const source = new AnthropicHeaderUsageSource();
    expect(await source.fetch()).toBeNull();
  });
});
