import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { mergeClaudeMcpServers } from "../../adapters/claude/claude-provider.js";
import {
  appendCursorMcodeInstructions,
  carryCursorMcodeSentState,
} from "../../../../../../../packages/providers/src/private/cursor/cursor-provider.js";
import { composeCopilotSystemMessage } from "../../adapters/copilot/copilot-provider.js";
import {
  buildMcodeInstructionPlan,
  MCODE_BROWSER_GUIDE,
  renderMcodeInstructions,
} from "@mcode/thread-orchestration";

describe("provider-native Mcode instruction boundaries", () => {
  it("keeps Claude internal and Browser MCP grants in one effective map", () => {
    const internal = { type: "sdk", instance: {} };
    const merged = mergeClaudeMcpServers(
      { mcode_internal_thread_control: internal },
      { mcpUrl: "http://127.0.0.1:1/mcp", token: "token" },
    );
    expect(merged.mcode_internal_thread_control).toBe(internal);
    expect(merged["mcode-browser"]).toMatchObject({ type: "http", url: "http://127.0.0.1:1/mcp" });
    expect(mergeClaudeMcpServers({}, null)).toEqual({});
  });

  it("delivers Cursor guidance once across accepted and unaccepted attempts", () => {
    const runtime = renderMcodeInstructions(buildMcodeInstructionPlan({
      browserAutomationGranted: true,
      threadControlGranted: false,
    }));
    const first = appendCursorMcodeInstructions("user rules", runtime, false);
    expect(first).toEqual({ instructionMarkdown: `user rules\n\n${runtime}`, included: true });
    expect(first.instructionMarkdown).toContain(MCODE_BROWSER_GUIDE.trim());

    const unacceptedRetry = appendCursorMcodeInstructions(first.instructionMarkdown, runtime, false);
    expect(unacceptedRetry).toEqual(first);

    const acceptedLater = appendCursorMcodeInstructions(first.instructionMarkdown, runtime, true);
    expect(acceptedLater).toEqual({ instructionMarkdown: first.instructionMarkdown, included: false });
    expect(carryCursorMcodeSentState(true, true)).toBe(true);
    expect(carryCursorMcodeSentState(false, true)).toBe(false);
  });

  it("preserves Copilot user instructions while appending runtime guidance", () => {
    expect(composeCopilotSystemMessage("user rules", "mcode runtime")).toEqual({
      content: "user rules\n\nmcode runtime",
    });
    expect(composeCopilotSystemMessage(undefined, "mcode runtime")).toEqual({
      content: "mcode runtime",
    });
  });
});
