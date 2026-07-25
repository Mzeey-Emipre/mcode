import { describe, it, expect } from "vitest";
import {
  MODEL_CONTEXT_WINDOWS,
  MODEL_CONTEXT_WINDOWS_DEFAULT,
  MODEL_CONTEXT_WINDOWS_EXTENDED,
  getModelContextWindow,
} from "../index.js";

describe("MODEL_CONTEXT_WINDOWS_DEFAULT", () => {
  it("exposes 200K as the default for every Claude model (no opt-in)", () => {
    expect(MODEL_CONTEXT_WINDOWS_DEFAULT["claude-opus-5"]).toBe(200_000);
    expect(MODEL_CONTEXT_WINDOWS_DEFAULT["claude-opus-4-8"]).toBe(200_000);
    expect(MODEL_CONTEXT_WINDOWS_DEFAULT["claude-opus-4-7"]).toBe(200_000);
    expect(MODEL_CONTEXT_WINDOWS_DEFAULT["claude-opus-4-6"]).toBe(200_000);
    expect(MODEL_CONTEXT_WINDOWS_DEFAULT["claude-sonnet-4-6"]).toBe(200_000);
    expect(MODEL_CONTEXT_WINDOWS_DEFAULT["claude-haiku-4-5"]).toBe(200_000);
  });

  it("MODEL_CONTEXT_WINDOWS alias points at the default map (back-compat)", () => {
    expect(MODEL_CONTEXT_WINDOWS).toBe(MODEL_CONTEXT_WINDOWS_DEFAULT);
  });
});

describe("MODEL_CONTEXT_WINDOWS_EXTENDED", () => {
  it("exposes 1M for Opus 5", () => {
    expect(MODEL_CONTEXT_WINDOWS_EXTENDED["claude-opus-5"]).toBe(1_000_000);
  });
  it("exposes 1M for Opus 4.8", () => {
    expect(MODEL_CONTEXT_WINDOWS_EXTENDED["claude-opus-4-8"]).toBe(1_000_000);
  });
  it("exposes 1M for Opus 4.7", () => {
    expect(MODEL_CONTEXT_WINDOWS_EXTENDED["claude-opus-4-7"]).toBe(1_000_000);
  });
  it("exposes 1M for Opus 4.6", () => {
    expect(MODEL_CONTEXT_WINDOWS_EXTENDED["claude-opus-4-6"]).toBe(1_000_000);
  });
  it("exposes 1M for Sonnet 4.6", () => {
    expect(MODEL_CONTEXT_WINDOWS_EXTENDED["claude-sonnet-4-6"]).toBe(1_000_000);
  });
  it("does NOT expose 1M for Haiku 4.5", () => {
    expect(MODEL_CONTEXT_WINDOWS_EXTENDED["claude-haiku-4-5"]).toBeUndefined();
  });
});

describe("getModelContextWindow", () => {
  // -------------------------------------------------------------------------
  // Default (200k) mode -- used when no opt-in is selected.
  // -------------------------------------------------------------------------

  it("returns 200K for every supported Claude model in 200k mode", () => {
    expect(getModelContextWindow("claude-opus-5", "200k")).toBe(200_000);
    expect(getModelContextWindow("claude-opus-4-8", "200k")).toBe(200_000);
    expect(getModelContextWindow("claude-opus-4-7", "200k")).toBe(200_000);
    expect(getModelContextWindow("claude-opus-4-6", "200k")).toBe(200_000);
    expect(getModelContextWindow("claude-sonnet-4-6", "200k")).toBe(200_000);
    expect(getModelContextWindow("claude-haiku-4-5", "200k")).toBe(200_000);
  });

  it("defaults to 200k when mode is omitted", () => {
    expect(getModelContextWindow("claude-sonnet-4-6")).toBe(200_000);
    expect(getModelContextWindow("claude-haiku-4-5")).toBe(200_000);
  });

  // -------------------------------------------------------------------------
  // 1M mode -- only models in the extended map honor the opt-in.
  // -------------------------------------------------------------------------

  it("returns 1M for opus-5/4-8/4-7/4-6 and sonnet-4-6 in 1m mode", () => {
    expect(getModelContextWindow("claude-opus-5", "1m")).toBe(1_000_000);
    expect(getModelContextWindow("claude-opus-4-8", "1m")).toBe(1_000_000);
    expect(getModelContextWindow("claude-opus-4-7", "1m")).toBe(1_000_000);
    expect(getModelContextWindow("claude-opus-4-6", "1m")).toBe(1_000_000);
    expect(getModelContextWindow("claude-sonnet-4-6", "1m")).toBe(1_000_000);
  });

  it("falls back to 200K for haiku-4-5 even in 1m mode (not supported)", () => {
    expect(getModelContextWindow("claude-haiku-4-5", "1m")).toBe(200_000);
  });

  // -------------------------------------------------------------------------
  // Dated SDK variants
  // -------------------------------------------------------------------------

  it("matches dated SDK variants by longest-prefix in 200k mode", () => {
    expect(getModelContextWindow("claude-haiku-4-5-20251001", "200k")).toBe(200_000);
    expect(getModelContextWindow("claude-sonnet-4-6-20260101", "200k")).toBe(200_000);
  });

  it("matches dated SDK variants in 1m mode", () => {
    expect(getModelContextWindow("claude-sonnet-4-6-20260101", "1m")).toBe(1_000_000);
    // Dated Haiku variant should still fall back to 200K.
    expect(getModelContextWindow("claude-haiku-4-5-20251001", "1m")).toBe(200_000);
  });

  // -------------------------------------------------------------------------
  // Unknown / invalid inputs
  // -------------------------------------------------------------------------

  it("returns undefined for unknown models in any mode", () => {
    expect(getModelContextWindow("gpt-5.4", "200k")).toBeUndefined();
    expect(getModelContextWindow("gpt-5.4", "1m")).toBeUndefined();
    expect(getModelContextWindow("", "200k")).toBeUndefined();
    expect(getModelContextWindow("not-a-real-model", "1m")).toBeUndefined();
    expect(getModelContextWindow("claude-haiku-4-5abc", "200k")).toBeUndefined();
  });
});
