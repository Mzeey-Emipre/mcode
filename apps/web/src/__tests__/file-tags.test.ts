import { describe, it, expect } from "vitest";
import { extractFileRefs, buildInjectedMessage } from "@/lib/file-tags";

describe("extractFileRefs", () => {
  it("extracts a single @path reference", () => {
    expect(extractFileRefs("check @src/main/index.ts please")).toEqual([
      "src/main/index.ts",
    ]);
  });

  it("extracts multiple @path references", () => {
    expect(
      extractFileRefs("compare @src/a.ts and @src/b.ts")
    ).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("returns empty array when no references", () => {
    expect(extractFileRefs("no files here")).toEqual([]);
  });

  it("handles @ at start of line", () => {
    expect(extractFileRefs("@package.json looks wrong")).toEqual([
      "package.json",
    ]);
  });

  it("ignores @ in email addresses", () => {
    expect(extractFileRefs("contact user@example.com")).toEqual([]);
  });

  it("handles paths with hyphens and dots", () => {
    expect(extractFileRefs("see @src/my-component.test.tsx")).toEqual([
      "src/my-component.test.tsx",
    ]);
  });

  it("stops at whitespace", () => {
    expect(extractFileRefs("@src/a.ts and more text")).toEqual(["src/a.ts"]);
  });

  it("handles paths with underscores", () => {
    expect(extractFileRefs("@src/__tests__/foo.test.ts")).toEqual([
      "src/__tests__/foo.test.ts",
    ]);
  });
});

describe("buildInjectedMessage", () => {
  it("appends file content after separator", () => {
    const result = buildInjectedMessage("check @src/a.ts", [
      { path: "src/a.ts", content: "const a = 1;" },
    ]);
    expect(result).toBe(
      'check @src/a.ts\n\n---\n<file path="src/a.ts">\nconst a = 1;\n</file>'
    );
  });

  it("appends multiple files", () => {
    const result = buildInjectedMessage("compare @a.ts and @b.ts", [
      { path: "a.ts", content: "const a = 1;" },
      { path: "b.ts", content: "const b = 2;" },
    ]);
    expect(result).toBe(
      'compare @a.ts and @b.ts\n\n---\n<file path="a.ts">\nconst a = 1;\n</file>\n<file path="b.ts">\nconst b = 2;\n</file>'
    );
  });

  it("returns original text when no files", () => {
    expect(buildInjectedMessage("hello", [])).toBe("hello");
  });
});
