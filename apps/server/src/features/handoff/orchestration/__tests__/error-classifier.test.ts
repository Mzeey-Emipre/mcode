import { describe, expect, it } from "vitest";
import { classifyProviderError, shouldSkipToDeterministic } from "../error-classifier.js";

describe("classifyProviderError", () => {
  it("returns quota for 429", () => {
    expect(classifyProviderError({ status: 429, message: "rate limited" })).toBe("quota");
  });

  it("returns quota for billing keywords", () => {
    expect(classifyProviderError({ message: "credit balance is too low" })).toBe("quota");
  });

  it("returns auth for 401", () => {
    expect(classifyProviderError({ status: 401, message: "unauthorized" })).toBe("auth");
  });

  it("returns context-overflow for prompt-too-long messages", () => {
    expect(classifyProviderError({ message: "prompt is too long: 200000 tokens" })).toBe("context-overflow");
  });

  it("returns transient for 5xx", () => {
    expect(classifyProviderError({ status: 503, message: "service unavailable" })).toBe("transient");
  });

  it("returns transient for ECONNRESET", () => {
    expect(classifyProviderError({ code: "ECONNRESET", message: "" })).toBe("transient");
  });

  it("returns fatal for everything else", () => {
    expect(classifyProviderError({ message: "model not found" })).toBe("fatal");
  });

  it("returns fatal for null input", () => {
    expect(classifyProviderError(null)).toBe("fatal");
  });

  it("returns transient for SDK wrapper errors", () => {
    expect(classifyProviderError({ message: "Claude side-channel query SDK error: unknown error" })).toBe("transient");
    expect(classifyProviderError({ message: "CLI subprocess crashed" })).toBe("transient");
  });

  it("returns context-overflow for token-count errors", () => {
    expect(classifyProviderError({ message: "Maximum context length exceeded" })).toBe("context-overflow");
    expect(classifyProviderError({ message: "Too many tokens in input" })).toBe("context-overflow");
  });
});

describe("shouldSkipToDeterministic", () => {
  it("returns true for quota, auth, context-overflow, fatal", () => {
    expect(shouldSkipToDeterministic("quota")).toBe(true);
    expect(shouldSkipToDeterministic("auth")).toBe(true);
    expect(shouldSkipToDeterministic("context-overflow")).toBe(true);
    expect(shouldSkipToDeterministic("fatal")).toBe(true);
  });

  it("returns false for transient and clean", () => {
    expect(shouldSkipToDeterministic("transient")).toBe(false);
    expect(shouldSkipToDeterministic("clean")).toBe(false);
  });
});
