import { describe, it, expect } from "vitest";
import { PlanOutputParser } from "../plan-output-parser.js";

describe("PlanOutputParser", () => {
  it("returns null when no fence is present", () => {
    const parser = new PlanOutputParser();
    expect(parser.feed("just some text")).toBeNull();
    expect(parser.feed(" more text")).toBeNull();
    expect(parser.hasPlan).toBe(false);
  });

  it("extracts a valid plan from a complete fence", () => {
    const parser = new PlanOutputParser();
    const json = JSON.stringify({
      title: "Auth Rewrite",
      sections: [
        {
          id: "s1",
          title: "Overview",
          level: 1,
          content: "Replace sessions with JWT.",
        },
      ],
    });
    parser.feed("Here is the plan:\n```plan-output\n");
    const result = parser.feed(`${json}\n\`\`\`\nMore text`);
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Auth Rewrite");
    expect(result!.sections).toHaveLength(1);
    expect(parser.hasPlan).toBe(true);
  });

  it("returns null for all calls after first successful parse", () => {
    const parser = new PlanOutputParser();
    const json = JSON.stringify({
      title: "Plan",
      sections: [{ id: "s1", title: "S1", level: 1, content: "Content" }],
    });
    parser.feed("```plan-output\n" + json + "\n```");
    const again = parser.feed("```plan-output\n" + json + "\n```");
    expect(again).toBeNull();
  });

  it("handles streaming deltas across multiple feed calls", () => {
    const parser = new PlanOutputParser();
    const json = JSON.stringify({
      title: "Streaming Plan",
      sections: [
        { id: "s1", title: "Step 1", level: 1, content: "Do the thing." },
      ],
    });

    parser.feed("```plan");
    parser.feed("-output\n");
    parser.feed(json.slice(0, 20));
    parser.feed(json.slice(20));
    const result = parser.feed("\n```");
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Streaming Plan");
  });

  it("returns null for malformed JSON", () => {
    const parser = new PlanOutputParser();
    parser.feed("```plan-output\n{bad json}\n```");
    expect(parser.hasPlan).toBe(false);
  });

  it("returns null for JSON that fails schema validation", () => {
    const parser = new PlanOutputParser();
    const bad = JSON.stringify({ title: "Plan", sections: [] }); // min(1) fails
    parser.feed("```plan-output\n" + bad + "\n```");
    expect(parser.hasPlan).toBe(false);
  });

  it("includes changeSummary when present", () => {
    const parser = new PlanOutputParser();
    const json = JSON.stringify({
      title: "Plan v2",
      changeSummary: "Shortened deprecation window to 14 days",
      sections: [
        { id: "s1", title: "Overview", level: 1, content: "Updated plan." },
      ],
    });
    const result = parser.feed("```plan-output\n" + json + "\n```");
    expect(result).not.toBeNull();
    expect(result!.changeSummary).toBe(
      "Shortened deprecation window to 14 days",
    );
  });

  it("skips malformed block and does not retry it", () => {
    const parser = new PlanOutputParser();
    parser.feed("```plan-output\n{bad}\n```");
    const json = JSON.stringify({
      title: "Good Plan",
      sections: [{ id: "s1", title: "S", level: 1, content: "C" }],
    });
    const result = parser.feed("\n```plan-output\n" + json + "\n```");
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Good Plan");
  });
});
