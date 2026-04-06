import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { roughTokenEstimate } from "../services/agent-service.js";

describe("roughTokenEstimate", () => {
  it("returns ceil(length / 4)", () => {
    // 100 chars → 25 tokens
    expect(roughTokenEstimate("a".repeat(100))).toBe(25);
  });

  it("rounds up for non-divisible lengths", () => {
    // 101 chars → ceil(101/4) = 26
    expect(roughTokenEstimate("a".repeat(101))).toBe(26);
  });

  it("returns 0 for empty string", () => {
    expect(roughTokenEstimate("")).toBe(0);
  });

  it("returns 1 for a single character", () => {
    expect(roughTokenEstimate("x")).toBe(1);
  });
});
