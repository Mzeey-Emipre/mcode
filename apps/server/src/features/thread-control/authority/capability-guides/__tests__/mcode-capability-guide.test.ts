import { describe, expect, it } from "vitest";
import {
  MCODE_BROWSER_GUIDE,
  THREAD_CONTROL_GUIDE,
  getMcodeBrowserGuide,
  getThreadControlGuide,
} from "../mcode-capability-guide.js";

describe("Mcode capability guide", () => {
  it("returns browser-only guidance", () => {
    const result = getMcodeBrowserGuide();

    expect(result).toEqual({ guide: MCODE_BROWSER_GUIDE });
    expect(result.guide).toContain("browser_inspect");
    expect(result.guide).toContain("browser_act");
    expect(result.guide).toContain("observationRef");
    expect(result.guide).toContain("yield_to_user");
    expect(result.guide).toContain("finalize");
    expect(result.guide).not.toContain("browser_status");
    expect(result.guide).not.toContain("expectedControlEpoch");
    expect(result.guide).not.toContain("thread_create_batch");
    expect(result.guide).not.toContain("workspace_search");
  });

  it("returns thread-control-only guidance", () => {
    const result = getThreadControlGuide();

    expect(result).toEqual({ guide: THREAD_CONTROL_GUIDE });
    expect(result.guide).toContain("workspace_search");
    expect(result.guide).toContain("thread_create_batch");
    expect(result.guide).toContain("active source thread's Project");
    expect(result.guide).toContain("requested Mcode thread");
    expect(result.guide).not.toMatch(/delegat(?:e|ed|ion|ing)/i);
    expect(result.guide).toContain("omit branchName");
    expect(result.guide).toContain("providerId codex");
    expect(result.guide).not.toContain("browser_inspect");
    expect(result.guide).not.toContain("observationRef");
  });
});
