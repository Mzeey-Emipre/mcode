import { describe, expect, it } from "vitest";
import { MCODE_CAPABILITY_GUIDE, getMcodeCapabilityGuide } from "../mcode-capability-guide.js";

describe("Mcode capability guide", () => {
  it("returns stable guidance for thread control and browser operations", () => {
    const result = getMcodeCapabilityGuide();

    expect(result).toEqual({ guide: MCODE_CAPABILITY_GUIDE });
    expect(result.guide).toContain("workspace_search");
    expect(result.guide).toContain("thread_create_batch");
    expect(result.guide).toContain("active source thread's Project");
    expect(result.guide).toContain("omit branchName");
    expect(result.guide).toContain("no branchName");
    expect(result.guide).toContain("providerId codex");
    expect(result.guide).toContain("browser_status");
    expect(result.guide).toContain("expectedControlEpoch");
    expect(result.guide).not.toContain("password");
    expect(result.guide).not.toContain("api key");
  });
});
