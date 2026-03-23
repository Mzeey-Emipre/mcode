import { describe, it, expect } from "vitest";
import {
  extractFileRefs,
  buildInjectedMessage,
  stripInjectedFiles,
} from "@/lib/file-tags";

describe("extractFileRefs", () => {
  it("extracts a single @path reference", () => {
    expect(extractFileRefs("check @src/main/index.ts please")).toEqual([
      "src/main/index.ts",
    ]);
  });

  it("extracts multiple @path references", () => {
    expect(
      extractFileRefs("compare @src/a.ts and @src/b.ts"),
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

  it("ignores @ mid-word (no preceding whitespace)", () => {
    expect(extractFileRefs("foo@bar/baz.ts")).toEqual([]);
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

  it("works correctly when called multiple times (no regex state leak)", () => {
    expect(extractFileRefs("@src/a.ts")).toEqual(["src/a.ts"]);
    expect(extractFileRefs("@src/b.ts")).toEqual(["src/b.ts"]);
    expect(extractFileRefs("no refs")).toEqual([]);
  });
});

describe("buildInjectedMessage", () => {
  it("appends file content after separator", () => {
    const result = buildInjectedMessage("check @src/a.ts", [
      { path: "src/a.ts", content: "const a = 1;" },
    ]);
    expect(result).toBe(
      'check @src/a.ts\n\n---\n<file path="src/a.ts">\nconst a = 1;\n</file>',
    );
  });

  it("appends multiple files", () => {
    const result = buildInjectedMessage("compare @a.ts and @b.ts", [
      { path: "a.ts", content: "const a = 1;" },
      { path: "b.ts", content: "const b = 2;" },
    ]);
    expect(result).toBe(
      'compare @a.ts and @b.ts\n\n---\n<file path="a.ts">\nconst a = 1;\n</file>\n<file path="b.ts">\nconst b = 2;\n</file>',
    );
  });

  it("returns original text when no files", () => {
    expect(buildInjectedMessage("hello", [])).toBe("hello");
  });

  it("escapes </file> sequences in content to prevent tag breakage", () => {
    const result = buildInjectedMessage("see @src/a.ts", [
      { path: "src/a.ts", content: 'const x = "</file>";' },
    ]);
    expect(result).toBe(
      'see @src/a.ts\n\n---\n<file path="src/a.ts">\nconst x = "<\\/file>";\n</file>',
    );
    // strip still works on escaped output
    expect(stripInjectedFiles(result)).toBe("see @src/a.ts");
  });
});

describe("stripInjectedFiles", () => {
  it("strips injected file blocks from a message", () => {
    const msg = 'check @src/a.ts\n\n---\n<file path="src/a.ts">\nconst a = 1;\n</file>';
    expect(stripInjectedFiles(msg)).toBe("check @src/a.ts");
  });

  it("returns original text when no file blocks present", () => {
    expect(stripInjectedFiles("hello world")).toBe("hello world");
  });

  it("returns empty string for empty input", () => {
    expect(stripInjectedFiles("")).toBe("");
  });

  it("strips multiple injected files", () => {
    const msg = 'text\n\n---\n<file path="a.ts">\na\n</file>\n<file path="b.ts">\nb\n</file>';
    expect(stripInjectedFiles(msg)).toBe("text");
  });

  it("is the inverse of buildInjectedMessage", () => {
    const original = "look at @src/foo.ts please";
    const injected = buildInjectedMessage(original, [
      { path: "src/foo.ts", content: "export const foo = 42;" },
    ]);
    expect(stripInjectedFiles(injected)).toBe(original);
  });
});
