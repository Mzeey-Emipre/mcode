import { describe, expect, it } from "vitest";
import {
  MCODE_INSTRUCTIONS_MAX_CHARS,
  buildMcodeInstructionPlan,
  renderMcodeInstructions,
} from "../index.js";

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
    expect(plan.text).toContain("mcode-browser");
    expect(plan.text).toContain("thread-source");
    expect(plan.text).not.toContain("http://");
    expect(plan.text).not.toContain("Bearer");
  });

  it("keeps output within the documented cap", () => {
    const plan = buildMcodeInstructionPlan({
      sourceThreadId: "x".repeat(256),
      threadControlGranted: true,
      browserAutomationGranted: false,
    });
    expect(plan.text.length).toBeLessThanOrEqual(MCODE_INSTRUCTIONS_MAX_CHARS);
  });

  it("renders canonical text unchanged", () => {
    const plan = buildMcodeInstructionPlan({
      threadControlGranted: false,
      browserAutomationGranted: true,
    });
    expect(renderMcodeInstructions(plan)).toBe(plan.text);
  });
});
