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

  it("keeps Mcode threads distinct from provider subagents", () => {
    const plan = buildMcodeInstructionPlan({
      sourceThreadId: "thread-source",
      threadControlGranted: true,
      browserAutomationGranted: false,
    });

    expect(plan.text).toContain(
      "An Mcode task/thread/delegated thread is a persistent user-visible conversation controlled by thread_* tools.",
    );
    expect(plan.text).toContain(
      "A subagent is provider/model-side delegation in the same turn.",
    );
    expect(plan.text).toContain("'use threads/tasks' maps to thread_* tools");
    expect(plan.text).toContain(
      "'use subagents' maps to the provider subagent mechanism",
    );
    expect(plan.text).toContain("Never translate one term into the other.");
    expect(plan.text).not.toContain("'use threads/tasks' maps to subagents");
    expect(plan.text).not.toContain("'use subagents' maps to thread_* tools");
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
