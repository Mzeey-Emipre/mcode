import { describe, expect, it } from "vitest";
import type { ToolCall } from "@/transport/types";
import { extractNarrativeCommand } from "../extract-narrative-command";

function shellCall(overrides: Partial<ToolCall>): ToolCall {
  return {
    id: "command-1",
    toolName: "command_execution",
    toolInput: {},
    output: null,
    isError: false,
    isComplete: true,
    ...overrides,
  };
}

describe("extractNarrativeCommand", () => {
  it("prefers the live command over a persisted provider summary", () => {
    expect(extractNarrativeCommand(shellCall({
      toolInput: {
        command: "git status --short",
        _summary: JSON.stringify({ command: "stale command" }),
      },
    }))).toBe("git status --short");
  });

  it("decodes a truncated legacy command summary without exposing JSON escapes", () => {
    const summary = JSON.stringify({ command: 'cd C:\\work\\repo && echo "ready"' })
      .slice(0, -2);

    expect(extractNarrativeCommand(shellCall({
      toolInput: { _summary: summary },
    }))).toBe('cd C:\\work\\repo && echo "ready"');
  });
});
