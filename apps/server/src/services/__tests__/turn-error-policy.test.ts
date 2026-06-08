import { describe, expect, it } from "vitest";
import { TurnErrorPolicy } from "../turn-error-policy.js";

describe("TurnErrorPolicy.classify", () => {
  const policy = new TurnErrorPolicy();

  it("classifies an unrecognized error as fatal", () => {
    expect(policy.classify(new Error("model refused: invalid request"))).toBe("fatal");
  });

  it("classifies a stale pooled session as transient", () => {
    expect(policy.classify(new Error("ACP connection closed"))).toBe("transient");
    expect(policy.classify(new Error("session invalidated"))).toBe("transient");
  });

  it("classifies a subprocess spawn race as transient", () => {
    expect(policy.classify(new Error("spawn claude EAGAIN"))).toBe("transient");
    expect(policy.classify(new Error("spawn codex ETXTBSY"))).toBe("transient");
  });

  it("keeps a missing-CLI spawn (ENOENT) fatal", () => {
    expect(policy.classify(new Error("spawn claude ENOENT"))).toBe("fatal");
  });

  it("classifies a brief network blip as transient", () => {
    expect(policy.classify(new Error("read ECONNRESET"))).toBe("transient");
    expect(policy.classify(new Error("connect ETIMEDOUT 1.2.3.4:443"))).toBe("transient");
    expect(policy.classify(new Error("socket hang up"))).toBe("transient");
    expect(policy.classify(new Error("fetch failed"))).toBe("transient");
  });

  it("matches against a raw string error and never throws on nullish input", () => {
    expect(policy.classify("read ECONNRESET")).toBe("transient");
    expect(policy.classify("permission denied")).toBe("fatal");
    expect(policy.classify(null)).toBe("fatal");
    expect(policy.classify(undefined)).toBe("fatal");
  });
});

describe("TurnErrorPolicy.shouldRetry", () => {
  const policy = new TurnErrorPolicy();

  it("retries a transient failure on the first attempt", () => {
    expect(policy.shouldRetry(new Error("read ECONNRESET"), 1)).toBe(true);
  });

  it("never retries a fatal failure", () => {
    expect(policy.shouldRetry(new Error("permission denied"), 1)).toBe(false);
  });

  it("stops retrying once the attempt cap is reached", () => {
    const transient = new Error("read ECONNRESET");
    expect(policy.shouldRetry(transient, 2)).toBe(false);
    expect(policy.shouldRetry(transient, 3)).toBe(false);
  });

  it("honors a custom attempt cap", () => {
    const noRetry = new TurnErrorPolicy(1);
    expect(noRetry.shouldRetry(new Error("read ECONNRESET"), 1)).toBe(false);
  });
});
