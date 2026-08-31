import { describe, expect, it } from "vitest";
import { buildMcodeInstructionPlan, isExplicitMcodeThreadRequest, MCODE_BROWSER_GUIDE } from "../index.js";

describe("Mcode runtime instruction plan", () => {
  it.each([
    "Spawn exactly one nested provider-native child named leaf_probe",
    "Delegate this task to a provider-native subagent",
  ])("does not grant Mcode thread control to provider-native child wording: %s", (request) => {
    expect(isExplicitMcodeThreadRequest(request)).toBe(false);
  });

  it.each([
    "Create one Mcode thread named leaf_probe",
    "Use thread_create_batch for the requested Mcode thread",
  ])("recognizes explicit Mcode thread requests: %s", (request) => {
    expect(isExplicitMcodeThreadRequest(request)).toBe(true);
  });

  it("fails closed for negated Mcode thread requests", () => {
    expect(isExplicitMcodeThreadRequest("Do not create an Mcode thread")).toBe(false);
  });

  it("always includes identity and excludes ungranted capabilities", () => {
    const plan = buildMcodeInstructionPlan({
      threadControlGranted: false,
      browserAutomationGranted: false,
    });
    expect(plan.text).toContain("Mcode-managed session");
    expect(plan.text).not.toContain("mcode_internal_thread_control");
    expect(plan.text).not.toContain("mcode-browser");
  });

  it("bounds broad repository searches before they print captured traces", () => {
    const plan = buildMcodeInstructionPlan({
      threadControlGranted: false,
      browserAutomationGranted: false,
    });

    expect(plan.text).toContain("first list files with rg -l");
    expect(plan.text).toContain("fixtures and captured traces (*.ndjson)");
    expect(plan.text).toContain("rg --max-columns 240");
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
    expect(plan.text).not.toContain("first list files with rg -l");
    expect(plan.text).toContain("thread-source");
    expect(plan.text).not.toContain("http://");
    expect(plan.text).not.toContain("Bearer");
  });

  it("routes explicit child-agent requests through provider collaboration", () => {
    const plan = buildMcodeInstructionPlan({
      sourceThreadId: "thread-source",
      threadControlGranted: true,
      browserAutomationGranted: false,
    });

    expect(plan.text).toContain("child-agent or sub-agent request");
    expect(plan.text).toContain("provider-native collaboration");
    expect(plan.text).toContain("preserve the exact requested brief");
    expect(plan.text).toContain("does not authorize Mcode thread control");
  });

  it("documents the nested-capable provider model when one is supplied", () => {
    const plan = buildMcodeInstructionPlan({
      threadControlGranted: false,
      browserAutomationGranted: false,
      nestedDelegationModel: "gpt-5.6-sol",
    });

    expect(plan.text).toContain("gpt-5.6-sol");
    expect(plan.text).toContain("parent spawn_agent call");
    expect(plan.text).toContain("Do not replace provider-native collaboration with shell commands");
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
    expect(MCODE_BROWSER_GUIDE).toContain("set disposition handoff and verify success");
  });
});
