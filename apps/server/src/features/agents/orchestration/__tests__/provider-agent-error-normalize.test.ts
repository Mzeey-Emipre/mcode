import { describe, expect, it } from "vitest";
import { normalizeProviderError } from "../../../providers/composition/provider-error-normalize.js";

describe("normalizeProviderError", () => {
  it("wraps vague Cursor upstream 5xx payloads", () => {
    const raw = "Internal Server Error";
    expect(normalizeProviderError("cursor", raw)).toContain(raw);
    expect(normalizeProviderError("cursor", raw)).toContain(
      "The Cursor CLI reported an upstream error",
    );
  });

  it("does not wrap the same wording for Claude", () => {
    const raw = "Internal Server Error";
    expect(normalizeProviderError("claude", raw)).toBe(raw);
  });

  it("keeps ENOENT mapping for Claude", () => {
    expect(normalizeProviderError("claude", "spawn foobar ENOENT")).toContain(
      "Claude CLI not found",
    );
  });

  it("handles HTTP-style status wording for Cursor", () => {
    const raw = "Request failed status code: 503";
    const out = normalizeProviderError("cursor", raw);
    expect(out).toContain(raw);
    expect(out).toContain("upstream error");
  });

  it("does not recursively wrap Cursor upstream errors once contextualized", () => {
    const once = normalizeProviderError("cursor", "Internal Server Error");
    expect(normalizeProviderError("cursor", once)).toEqual(once);
  });

  it("rewrites the minified resource_exhausted rate limit for Cursor", () => {
    const raw = "v: [resource_exhausted] Error";
    const out = normalizeProviderError("cursor", raw);
    expect(out).toContain("rate-limiting");
    expect(out).toContain("switch to a Fast model");
    expect(out).toContain(raw);
  });

  it("does not wrap resource_exhausted wording for non-Cursor providers", () => {
    const raw = "v: [resource_exhausted] Error";
    expect(normalizeProviderError("claude", raw)).toBe(raw);
  });

  it("does not recursively wrap the Cursor rate-limit message", () => {
    const once = normalizeProviderError("cursor", "v: [resource_exhausted] Error");
    expect(normalizeProviderError("cursor", once)).toEqual(once);
  });
});
