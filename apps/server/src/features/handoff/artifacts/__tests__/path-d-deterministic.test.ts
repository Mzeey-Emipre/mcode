import { describe, expect, it } from "vitest";
import { runPathDDeterministic, type PathDInput } from "../path-d-deterministic.js";
import { parseHandoffJson } from "@mcode/contracts";
import type { Thread, Message, ToolCallRecord, ThoughtSegmentRecord } from "@mcode/contracts";

const parent = {
  id: "t_parent",
  workspace_id: "w_1",
  title: "DB migration",
  branch: "main",
  provider: "claude",
  model: "claude-opus-4-7",
  status: "active",
  worktree_path: null,
  worktree_managed: true,
  sdk_session_id: null,
  last_compact_summary: null,
} as unknown as Thread;

const messages: Message[] = [
  {
    id: "m_1",
    thread_id: "t_parent",
    role: "user",
    content: "Should we use Postgres?",
    sequence: 1,
  } as unknown as Message,
  {
    id: "m_2",
    thread_id: "t_parent",
    role: "assistant",
    content: "Yes because it scales.",
    sequence: 2,
  } as unknown as Message,
];

function mkTool(over: Partial<ToolCallRecord>): ToolCallRecord {
  return {
    id: "tc_1",
    message_id: "m_2",
    parent_tool_call_id: null,
    tool_name: "Read",
    input_summary: "src/index.ts",
    output_summary: "...",
    status: "completed",
    started_at: "2026-01-01T00:00:00Z",
    completed_at: "2026-01-01T00:00:01Z",
    sort_order: 0,
    ...over,
  };
}

function mkThought(over: Partial<ThoughtSegmentRecord>): ThoughtSegmentRecord {
  return {
    id: "ts_1",
    message_id: "m_2",
    text: "Considering the schema migration order.",
    started_at: "2026-01-01T00:00:00Z",
    ended_at: "2026-01-01T00:00:01Z",
    sort_order: 0,
    is_final_response: 0,
    ...over,
  };
}

const BASE: PathDInput = {
  parentThread: parent,
  messagesUpToFork: messages,
  forkedFromMessageId: "m_2",
  forkAnchorRole: "assistant",
  childThreadId: "t_child",
  reason: null,
};

describe("runPathDDeterministic", () => {
  it("always tags ladderStep D, generatedBy deterministic, and matches characterCount", async () => {
    const a = await runPathDDeterministic({ ...BASE, reason: "quota" });
    expect(a.meta.ladderStep).toBe("D");
    expect(a.meta.generatedBy).toBe("deterministic");
    expect(a.meta.providerErrorOnGenerate).toBe("quota");
    expect(a.meta.characterCount).toBe(a.markdown.length);
    expect(a.markdown.length).toBeGreaterThan(0);
  });

  it("surfaces history budget elision in the handoff body and metadata", async () => {
    const a = await runPathDDeterministic({
      ...BASE,
      historyBudget: {
        budgetBytes: 10,
        retainedBytes: 10,
        omittedBeforeCount: 2,
        truncatedMessages: [{ id: "m_2", originalBytes: 20, retainedBytes: 10 }],
      },
    });

    expect(a.markdown).toContain("## History limit");
    expect(a.markdown).toContain("2 earlier messages were elided");
    expect(a.markdown).toContain("1 retained message was truncated");
    expect(a.meta.historyBudget?.omittedBeforeCount).toBe(2);
  });

  it("is deterministic for fixed input (modulo generatedAt)", async () => {
    const input: PathDInput = {
      ...BASE,
      compactSummary: "We migrated the users table.",
      toolCallRecords: [mkTool({}), mkTool({ id: "tc_2", tool_name: "Edit", sort_order: 1 })],
      thoughtSegments: [mkThought({})],
      filesChanged: ["a.ts", "b.ts"],
    };
    const a = await runPathDDeterministic(input);
    const b = await runPathDDeterministic(input);
    const strip = (m: string) => m; // markdown body has no timestamps
    expect(strip(a.markdown)).toBe(strip(b.markdown));
  });

  describe("section presence", () => {
    it("(a) no tool calls: omits Recent tool activity", async () => {
      const a = await runPathDDeterministic({ ...BASE, toolCallRecords: [] });
      expect(a.markdown).not.toContain("## Recent tool activity");
    });

    it("(b) many tool calls: includes Recent tool activity with each tool", async () => {
      const tools = Array.from({ length: 6 }, (_, i) =>
        mkTool({ id: `tc_${i}`, tool_name: `Tool${i}`, sort_order: i }),
      );
      const a = await runPathDDeterministic({ ...BASE, toolCallRecords: tools });
      expect(a.markdown).toContain("## Recent tool activity");
      for (let i = 0; i < 6; i++) expect(a.markdown).toContain(`Tool${i}`);
    });

    it("(c) no compact summary: falls back to Recent context heading", async () => {
      const a = await runPathDDeterministic({ ...BASE, compactSummary: null });
      expect(a.markdown).not.toContain("## Summary");
      expect(a.markdown).toContain("## Recent context");
    });

    it("(d) present compact summary: uses Summary heading and includes the text", async () => {
      const a = await runPathDDeterministic({ ...BASE, compactSummary: "Migrated users table." });
      expect(a.markdown).toContain("## Summary");
      expect(a.markdown).toContain("Migrated users table.");
    });

    it("(e1) present filesChanged: includes Recent files changed section", async () => {
      const a = await runPathDDeterministic({ ...BASE, filesChanged: ["x.ts", "y.ts"] });
      expect(a.markdown).toContain("## Recent files changed");
      expect(a.markdown).toContain("- x.ts");
      expect(a.markdown).toContain("- y.ts");
    });

    it("(e2) absent filesChanged: omits Recent files changed section", async () => {
      const a = await runPathDDeterministic({ ...BASE, filesChanged: [] });
      expect(a.markdown).not.toContain("## Recent files changed");
    });

    it("(f1) present fork-anchor body with a compact summary: renders Fork-anchor context", async () => {
      const a = await runPathDDeterministic({
        ...BASE,
        compactSummary: "Summary here.",
        forkAnchorBody: "The anchor message body.",
      });
      expect(a.markdown).toContain("## Fork-anchor context");
      expect(a.markdown).toContain("The anchor message body.");
    });

    it("(f2) fork-anchor body used as goal when no compact summary: no separate section", async () => {
      const a = await runPathDDeterministic({
        ...BASE,
        compactSummary: null,
        forkAnchorBody: "The anchor body becomes the goal.",
      });
      expect(a.markdown).toContain("## Recent context");
      expect(a.markdown).toContain("The anchor body becomes the goal.");
      expect(a.markdown).not.toContain("## Fork-anchor context");
    });

    it("(f3) absent fork-anchor body: no Fork-anchor context section", async () => {
      const a = await runPathDDeterministic({
        ...BASE,
        compactSummary: "Summary only.",
        forkAnchorBody: null,
      });
      expect(a.markdown).not.toContain("## Fork-anchor context");
    });

    it("narration highlights: includes non-final segments, excludes final-response", async () => {
      const a = await runPathDDeterministic({
        ...BASE,
        thoughtSegments: [
          mkThought({ id: "n1", text: "planning step", is_final_response: 0 }),
          mkThought({ id: "n2", text: "final answer", is_final_response: 1 }),
        ],
      });
      expect(a.markdown).toContain("## Narration / reasoning highlights");
      expect(a.markdown).toContain("planning step");
      expect(a.markdown).not.toContain("- final answer");
    });

    it("empty everything: still produces a valid doc with title and metadata marker", async () => {
      const a = await runPathDDeterministic({
        parentThread: parent,
        messagesUpToFork: [],
        forkedFromMessageId: "m_x",
        forkAnchorRole: "user",
        childThreadId: "t_child",
        reason: null,
      });
      expect(a.markdown).toContain("# Handoff (deterministic)");
      expect(a.meta.ladderStep).toBe("D");
      expect(a.markdown).not.toContain("## Recent tool activity");
      expect(a.markdown).not.toContain("## Narration");
    });

    it("preserves full summary without 2000-char truncation", async () => {
      const long = "X".repeat(5000);
      const a = await runPathDDeterministic({ ...BASE, compactSummary: long });
      expect(a.markdown).toContain(long);
    });

    it("escapes HTML comment terminators in metadata so the marker round-trips", async () => {
      // A parent title containing `-->` would otherwise close the HTML comment
      // early and break the embedded JSON block.
      const evilTitle = 'Fix bug --> done <!-- sneaky';
      const a = await runPathDDeterministic({
        ...BASE,
        parentThread: { ...parent, title: evilTitle } as unknown as Thread,
      });
      // The metadata block must not contain a raw `-->` or `<!--` terminator.
      const markerIdx = a.markdown.indexOf("<!-- mcode-handoff");
      const jsonBlock = a.markdown.slice(markerIdx + "<!-- mcode-handoff".length);
      const closeIdx = jsonBlock.lastIndexOf("-->");
      expect(closeIdx).toBeGreaterThan(0);
      const innerJson = jsonBlock.slice(0, closeIdx);
      expect(innerJson).not.toContain("-->");
      // The parser still restores the original title (\u003e parses back to >).
      const parsed = parseHandoffJson(a.markdown);
      expect(parsed).not.toBeNull();
      expect(parsed?.parentTitle).toBe(evilTitle);
    });
  });
});
