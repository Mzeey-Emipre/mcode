import { describe, expect, it } from "vitest";
import { buildMcodeInstructionPlan, MCODE_BROWSER_GUIDE } from "../index.js";

describe("Mcode runtime instruction plan", () => {
  it("always includes identity and excludes ungranted capabilities", () => {
    const plan = buildMcodeInstructionPlan({
      threadControlGranted: false,
      browserAutomationGranted: false,
    });
    expect(plan.text).toContain("Mcode-managed session");
    expect(plan.text).not.toContain("mcode_internal_thread_control");
    expect(plan.text).not.toContain("mcode-browser");
  });

  it("includes only capabilities proven available", () => {
    const plan = buildMcodeInstructionPlan({
      sourceThreadId: "thread-source",
      threadControlGranted: true,
      browserAutomationGranted: true,
    });
    expect(plan.capabilities).toEqual({
      threadControl: { sourceThreadId: "thread-source" },
      browserAutomation: true,
    });
    expect(plan.text).toContain("mcode_internal_thread_control");
    expect(plan.text).toContain(MCODE_BROWSER_GUIDE.trim());
    expect(plan.text).toContain("prefer semanticId from the latest observation");
    expect(plan.text).toContain("browser_open");
    expect(plan.text).toContain("browser_inspect");
    expect(plan.text).toContain("browser_act");
    expect(plan.text).toContain("browser_tabs");
    expect(plan.text).toContain("observationRef");
    expect(plan.text).toContain("yield_to_user");
    expect(plan.text).toContain("finalize");
    expect(plan.text).not.toContain("browser_status");
    expect(plan.text).not.toContain("browser_snapshot");
    expect(plan.text).toContain("thread-source");
    expect(plan.text).not.toContain("http://");
    expect(plan.text).not.toContain("Bearer");
  });
});
