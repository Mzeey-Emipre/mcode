import { describe, expect, it } from "vitest";
import {
  BROWSER_V2_LEGACY_ROLLBACK_ENV,
  resolveBrowserAutomationRollout,
} from "./rollout-policy.js";

describe("Browser v2 rollout policy", () => {
  it("enables one Browser v2 surface for development and nightly builds", () => {
    expect(resolveBrowserAutomationRollout({ nodeEnv: "development", version: "0.13.0" }))
      .toEqual({ mode: "browser-v2", reason: "development", rollbackActive: false });
    expect(resolveBrowserAutomationRollout({ nodeEnv: "production", version: "0.13.0-nightly.20260812.42" }))
      .toEqual({ mode: "browser-v2", reason: "nightly", rollbackActive: false });
  });

  it("keeps stable builds on the legacy surface before promotion", () => {
    expect(resolveBrowserAutomationRollout({ nodeEnv: "production", version: "0.13.0" }))
      .toEqual({ mode: "legacy", reason: "stable", rollbackActive: false });
  });

  it("uses one exact hidden rollback switch for every release line", () => {
    const input = {
      nodeEnv: "production",
      version: "0.13.0-nightly.20260812.42",
      environment: { [BROWSER_V2_LEGACY_ROLLBACK_ENV]: "1" },
    };
    expect(resolveBrowserAutomationRollout(input))
      .toEqual({ mode: "legacy", reason: "legacy-rollback", rollbackActive: true });
    expect(resolveBrowserAutomationRollout({ ...input, environment: { [BROWSER_V2_LEGACY_ROLLBACK_ENV]: "true" } }).mode)
      .toBe("browser-v2");
  });
});
