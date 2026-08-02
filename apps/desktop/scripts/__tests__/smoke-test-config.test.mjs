import { describe, expect, it } from "vitest";
import {
  classifySmokeOutcome,
  getSmokeTimeoutMs,
} from "../smoke-test-config.mjs";

describe("getSmokeTimeoutMs", () => {
  it("keeps the default budget for native and non-macOS targets", () => {
    expect(getSmokeTimeoutMs({
      hostPlatform: "linux",
      hostArch: "x64",
      targetPlatform: "linux",
      targetArch: "x64",
    })).toBe(30_000);
    expect(getSmokeTimeoutMs({
      hostPlatform: "darwin",
      hostArch: "arm64",
      targetPlatform: "darwin",
      targetArch: "arm64",
    })).toBe(30_000);
  });

  it("extends the budget only for an Apple Silicon host running x64 macOS", () => {
    expect(getSmokeTimeoutMs({
      hostPlatform: "darwin",
      hostArch: "arm64",
      targetPlatform: "darwin",
      targetArch: "x64",
    })).toBe(60_000);
    expect(getSmokeTimeoutMs({
      hostPlatform: "darwin",
      hostArch: "x64",
      targetPlatform: "darwin",
      targetArch: "x64",
    })).toBe(30_000);
  });
});

describe("classifySmokeOutcome", () => {
  it("preserves a deadline miss after cleanup observes the SIGTERM exit", () => {
    let exited = false;
    const outcomeAtDeadline = classifySmokeOutcome({
      healthy: false,
      exitedAtDeadline: exited,
    });
    exited = true;

    expect(outcomeAtDeadline).toBe("timed-out");
    expect(exited).toBe(true);
  });

  it("classifies a child that exited before readiness as crashed", () => {
    expect(classifySmokeOutcome({
      healthy: false,
      exitedAtDeadline: true,
    })).toBe("crashed");
  });

  it("classifies a healthy response as success", () => {
    expect(classifySmokeOutcome({
      healthy: true,
      exitedAtDeadline: false,
    })).toBe("healthy");
  });
});
