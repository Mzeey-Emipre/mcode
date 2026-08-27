import { describe, expect, it } from "vitest";
import {
  enrichAcpToolInput,
  formatAcpToolResultOutput,
} from "../cursor-acp-tool-input-enrichment.js";

describe("cursor-acp-tool-input-enrichment", () => {
  it("fills Read file_path from rawOutput.path when present", () => {
    const input = enrichAcpToolInput(
      "Read",
      { kind: "read", title: "Read File" },
      {},
      { path: "apps/server/src/foo.ts", content: "body" },
      [],
    );
    expect(input.file_path).toBe("apps/server/src/foo.ts");
  });

  it("synthesizes Grep pattern from totalMatches when args are absent", () => {
    const input = enrichAcpToolInput(
      "Grep",
      { kind: "search", title: "grep" },
      {},
      { totalMatches: 16, truncated: false },
      [],
    );
    expect(input.pattern).toBe("16 matches");
  });

  it("maps Grep pattern and path from rawInput on completion", () => {
    const input = enrichAcpToolInput(
      "Grep",
      { kind: "search", title: "grep" },
      { pattern: "cursor/task", path: "apps/server" },
      { totalMatches: 3 },
      [],
    );
    expect(input).toMatchObject({ pattern: "cursor/task", path: "apps/server" });
  });

  it("fills Bash command from rawInput on execute tool_call", () => {
    const input = enrichAcpToolInput(
      "Bash",
      { kind: "execute", title: "`echo hi`" },
      { command: "echo hi" },
      { exitCode: 0, stdout: "hi\n" },
      [],
    );
    expect(input.command).toBe("echo hi");
  });

  it("formats edit diff results with path", () => {
    const out = formatAcpToolResultOutput("Edit", undefined, [
      {
        type: "diff",
        path: "/tmp/a.txt",
        oldText: "a",
        newText: "b",
      },
    ]);
    expect(out).toBe("Applied edit to /tmp/a.txt");
  });
});
