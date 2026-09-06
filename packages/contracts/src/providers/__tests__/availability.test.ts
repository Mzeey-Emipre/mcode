import { describe, it, expect } from "vitest";
import { ProviderAvailabilitySchema, CliStatusSchema } from "../availability.js";

describe("ProviderAvailabilitySchema", () => {
  it("accepts a fully populated availability record", () => {
    const parsed = ProviderAvailabilitySchema().parse({
      id: "claude",
      enabled: true,
      hasAdapter: true,
      beta: false,
      comingSoon: false,
      capabilities: [],
      cli: { status: "found", resolvedPath: "/usr/local/bin/claude", configuredPath: "" },
    });
    expect(parsed.id).toBe("claude");
  });

  it("rejects unknown cli.status values", () => {
    expect(() => CliStatusSchema().parse("sideways")).toThrow();
  });
});
