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
    expect(plan.text).toContain("manage Mcode threads only when explicitly asked by the user");
    expect(plan.text).not.toMatch(/delegat(?:e|ed|ion|ing)/i);
    expect(plan.text).toContain(MCODE_BROWSER_GUIDE.trim());
    expect(plan.text).toContain("thread-source");
    expect(plan.text).not.toContain("http://");
    expect(plan.text).not.toContain("Bearer");
  });

  it("makes the Mcode Preview Browser boundary and action shape authoritative", () => {
    expect(MCODE_BROWSER_GUIDE).toContain("use only mcode-browser for Mcode's shared Preview");
    expect(MCODE_BROWSER_GUIDE).toMatch(/never initialize or use bundled generic Browser\/Chrome\/Node-REPL/i);
    expect(MCODE_BROWSER_GUIDE).toContain("Browser-only");
    expect(MCODE_BROWSER_GUIDE).toContain("do not run shell/terminal commands or read local skills/files");
    expect(MCODE_BROWSER_GUIDE).toContain("latest observationRef");
    expect(MCODE_BROWSER_GUIDE).toContain("fresh idempotencyKey");
    expect(MCODE_BROWSER_GUIDE).toContain("non-empty steps array");
    expect(MCODE_BROWSER_GUIDE).toContain("wait durationMs");
    expect(MCODE_BROWSER_GUIDE).toContain("click target");
    expect(MCODE_BROWSER_GUIDE).toContain("assert text/target/url");
    expect(MCODE_BROWSER_GUIDE).toContain('"steps": [{ "operation": "click"');
    expect(MCODE_BROWSER_GUIDE).toContain("Never send `steps: []`");
  });
});
