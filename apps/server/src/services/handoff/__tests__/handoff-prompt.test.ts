import { describe, expect, it } from "vitest";
import { buildHandoffPrompt } from "../handoff-prompt.js";

describe("buildHandoffPrompt", () => {
  const baseInput = {
    forkAnchorRole: "assistant" as const,
    parentThreadTitle: "Database migration design",
    forkMessageExcerpt: "We should use Postgres because...",
    childProviderId: "claude",
    userFollowUpMessage: "what about feature X?",
  };

  it("quotes the /handoff skill instructions verbatim", () => {
    const p = buildHandoffPrompt(baseInput);
    expect(p).toContain("Write a handoff document summarising the current conversation so a fresh agent can continue the work.");
    expect(p).toContain(`Include a "suggested skills" section in the document, which suggests skills that the agent should invoke.`);
    expect(p).toContain("Do not duplicate content already captured in other artifacts");
    expect(p).toContain("Redact any sensitive information");
    expect(p).toContain("If the user passed arguments, treat them as a description of what the next session will focus on");
  });

  it("handles missing follow-up message by saying so explicitly", () => {
    const p = buildHandoffPrompt({ ...baseInput, userFollowUpMessage: "" });
    expect(p).toMatch(/has not provided a follow-up message yet/i);
    expect(p).toMatch(/no skill arguments/i);
  });

  it("asks for a complete doc with no character cap (off-band delivery)", () => {
    const p = buildHandoffPrompt(baseInput);
    // The full-vs-minimal mode, the per-turn character budget, and the
    // overflow/truncation guard were retired by off-band delivery (PRD #538).
    expect(p.toLowerCase()).toContain("off-band");
    expect(p.toLowerCase()).toContain("no character cap");
    expect(p.toLowerCase()).not.toMatch(/less than or equal to \d/);
    expect(p.toLowerCase()).not.toContain("output mode:");
  });

  it("caps the requested handoff size for Codex inline delivery", () => {
    const p = buildHandoffPrompt({ ...baseInput, childProviderId: "codex" });
    expect(p.toLowerCase()).toContain("under 12,000 characters");
    expect(p.toLowerCase()).toContain("codex receives this handoff inline");
    expect(p.toLowerCase()).not.toContain("no character cap");
  });

  it("frames user-msg fork as retry, assistant-msg fork as follow-up about assistant reply", () => {
    const userFork = buildHandoffPrompt({ ...baseInput, forkAnchorRole: "user" });
    expect(userFork).toMatch(/retry this question/i);
    const asstFork = buildHandoffPrompt({ ...baseInput, forkAnchorRole: "assistant" });
    expect(asstFork).toMatch(/follow-up about what the assistant just said/i);
  });

  it("includes the user's follow-up message in the prompt", () => {
    const p = buildHandoffPrompt(baseInput);
    expect(p).toContain("what about feature X?");
  });

  it("instructs the model to return markdown as response text, not call tools", () => {
    const p = buildHandoffPrompt(baseInput);
    expect(p).toMatch(/return.*handoff.*document.*response/i);
    expect(p).toMatch(/do not call any tools/i);
    expect(p).toMatch(/do not write to disk/i);
  });
});
