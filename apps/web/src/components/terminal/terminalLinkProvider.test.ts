import { describe, expect, it } from "vitest";
import {
  findTerminalLinks,
  parseTerminalLink,
  terminalLinkCellRange,
} from "./terminalLinkProvider";

describe("parseTerminalLink", () => {
  it("accepts absolute file targets with bounded location metadata", () => {
    expect(parseTerminalLink("C:\\repo\\src\\main.ts:12:4")).toEqual({
      path: "C:\\repo\\src\\main.ts",
      line: 12,
      column: 4,
    });
    expect(parseTerminalLink("/workspace/src/main.ts:8")).toEqual({
      path: "/workspace/src/main.ts",
      line: 8,
    });
  });

  it("rejects URLs, traversal, relative paths, and unbounded locations", () => {
    expect(parseTerminalLink("https://example.test/file.ts:1")).toBeNull();
    expect(parseTerminalLink("../../src/main.ts:1")).toBeNull();
    expect(parseTerminalLink("src/main.ts:1")).toBeNull();
    expect(parseTerminalLink("/workspace/src/main.ts:1000001")).toBeNull();
    expect(parseTerminalLink("/workspace/src/\u0001main.ts:1")).toBeNull();
  });

  it("finds only a safe file target inside a diagnostic line", () => {
    expect(findTerminalLinks("error: /workspace/src/main.ts:8:2")).toEqual([expect.objectContaining({
      text: "/workspace/src/main.ts:8:2",
      target: { path: "/workspace/src/main.ts", line: 8, column: 2 },
    })]);
    expect(findTerminalLinks("error: https://example.test/file.ts:8")).toEqual([]);
  });

  it("returns every safe link and maps ranges after a wide Unicode prefix", () => {
    const text = "界 /workspace/src/a.ts:8 /workspace/src/b.ts:12";
    const cells = Array.from(text).flatMap((chars) => {
      const width = chars === "界" ? 2 : 1;
      return [
        { getChars: () => chars, getWidth: () => width },
        ...(width === 2 ? [{ getChars: () => "", getWidth: () => 0 }] : []),
      ];
    });
    const line = {
      length: cells.length,
      getCell: (index: number) => cells[index],
    };
    const links = findTerminalLinks(text);

    expect(links).toHaveLength(2);
    expect(terminalLinkCellRange(line, links[0]!)).toEqual({
      start: 3,
      end: 3 + links[0]!.text.length,
    });
    expect(terminalLinkCellRange(line, links[1]!)).toEqual({
      start: 4 + links[0]!.text.length,
      end: 4 + links[0]!.text.length + links[1]!.text.length,
    });
  });
});
