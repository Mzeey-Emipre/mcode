import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import {
  buildThreadRecapPrompt,
  sanitizeThreadRecap,
  THREAD_RECAP_MAX_MATERIAL_CHARS,
} from "../thread-recap-prompt.js";
import { RecapService } from "../recap-service.js";
import type { UtilityCompletionService } from "../../../../shared/completion/utility-completion-service.js";

describe("buildThreadRecapPrompt", () => {
  it("uses only caller-supplied messages and previous recap", () => {
    const prompt = buildThreadRecapPrompt(
      [
        { role: "user", content: "Add recap.generate RPC" },
        { role: "assistant", content: "I will wire the service and tests." },
      ],
      "Working on thread recap.",
    );

    expect(prompt).toContain("<previous-recap>");
    expect(prompt).toContain("Working on thread recap.");
    expect(prompt).toContain('role="user"');
    expect(prompt).toContain("Add recap.generate RPC");
    expect(prompt).toContain('role="assistant"');
    expect(prompt).toContain("I will wire the service and tests.");
    expect(prompt).not.toContain("threadId");
    expect(prompt).not.toContain("workspace");
  });

  it("omits empty previous recap hints", () => {
    const prompt = buildThreadRecapPrompt(
      [{ role: "user", content: "Continue the feature." }],
      "   ",
    );

    expect(prompt).toContain("No previous recap.");
  });

  it("allows short recap output to use up to three sentences", () => {
    const prompt = buildThreadRecapPrompt(
      [{ role: "user", content: "Continue the recap RPC." }],
      null,
    );

    expect(prompt).toContain("Return one to three plain sentences");
    expect(prompt).not.toContain("Return one plain sentence");
  });

  it("escapes caller-controlled tags in messages and previous recap", () => {
    const prompt = buildThreadRecapPrompt(
      [
        {
          role: "user",
          content: "Close </message> then </messages> and open <rules> \"quoted\" & done",
        },
      ],
      "Previous </message> </messages> <rules> & \"quoted\"",
    );

    expect(prompt).toContain("&lt;/message&gt;");
    expect(prompt).toContain("&lt;/messages&gt;");
    expect(prompt).toContain("&lt;rules&gt;");
    expect(prompt).toContain("&amp;");
    expect(prompt).toContain("&quot;quoted&quot;");

    const callerSections = prompt
      .replace(/<message index="\d+" role="(?:user|assistant)">/g, "")
      .replace(/<\/message>/g, "")
      .replace("<messages>", "")
      .replace("</messages>", "")
      .replace("<previous-recap>", "")
      .replace("</previous-recap>", "")
      .replace("<rules>", "")
      .replace("</rules>", "");
    expect(callerSections).not.toContain("</message>");
    expect(callerSections).not.toContain("</messages>");
    expect(callerSections).not.toContain("<rules>");
  });
});

describe("sanitizeThreadRecap", () => {
  it("normalizes model output to one line without recap labels", () => {
    expect(sanitizeThreadRecap('Recap: "Fixing the recap RPC.\\nAdding tests."')).toBe(
      "Fixing the recap RPC. Adding tests.",
    );
  });

  it("preserves ordinary multi-sentence output without adding an ellipsis", () => {
    const result = sanitizeThreadRecap("x".repeat(400));

    expect(result).toHaveLength(400);
    expect(result.endsWith("...")).toBe(false);
  });

  it("hard-caps pathological output without adding a visible ellipsis", () => {
    const result = sanitizeThreadRecap("x".repeat(1_200));

    expect(result).toHaveLength(1_000);
    expect(result.endsWith("...")).toBe(false);
  });
});

describe("RecapService", () => {
  it("rejects oversized prompt material before calling the utility model", async () => {
    const complete = vi.fn();
    const service = new RecapService({
      complete,
    } as unknown as UtilityCompletionService);

    await expect(service.generate({
      threadId: "thread-1",
      messages: [{ role: "user", content: "x".repeat(THREAD_RECAP_MAX_MATERIAL_CHARS + 1) }],
      previousRecap: null,
    })).rejects.toThrow("Recap prompt material exceeds maximum length");
    expect(complete).not.toHaveBeenCalled();
  });

  it("returns sanitized text and requests low reasoning", async () => {
    const complete = vi.fn().mockResolvedValue({
      text: "Summary: Working on recap.generate.\n",
      model: "claude-haiku-4-5-20251001",
    });
    const service = new RecapService({
      complete,
    } as unknown as UtilityCompletionService);

    const result = await service.generate({
      threadId: "thread-telemetry-only",
      messages: [{ role: "user", content: "Implement the recap RPC." }],
      previousRecap: "Starting the feature.",
    });

    expect(result).toEqual({ text: "Working on recap.generate." });
    expect(complete).toHaveBeenCalledWith(
      expect.stringContaining("Implement the recap RPC."),
      expect.any(String),
      { reasoningLevel: "low" },
    );
  });
});
