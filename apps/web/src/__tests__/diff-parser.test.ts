import { describe, it, expect } from "vitest";
import { parseDiffLines, isMarkdownFile, reconstructNewContent } from "../lib/diff-parser";

describe("parseDiffLines", () => {
  describe("hiddenLineCount on hunk headers", () => {
    it("sets hiddenLineCount to 0 when first hunk starts at line 1", () => {
      const diff = `@@ -1,5 +1,5 @@
 context
-removed
+added
 context
 context`;
      const lines = parseDiffLines(diff);
      const header = lines.find((l) => l.type === "header" && l.content.startsWith("@@"));
      expect(header?.hiddenLineCount).toBe(0);
    });

    it("sets hiddenLineCount to lines before first hunk when hunk starts after line 1", () => {
      const diff = `@@ -10,3 +10,3 @@
 context
-removed
+added`;
      const lines = parseDiffLines(diff);
      const header = lines.find((l) => l.type === "header" && l.content.startsWith("@@"));
      expect(header?.hiddenLineCount).toBe(9);
    });

    it("computes gap between consecutive hunks", () => {
      const diff = `@@ -1,3 +1,3 @@
 context
-old
+new
 context
@@ -10,3 +10,3 @@
 context
-old2
+new2`;
      const lines = parseDiffLines(diff);
      const headers = lines.filter((l) => l.type === "header" && l.content.startsWith("@@"));
      expect(headers[0]?.hiddenLineCount).toBe(0); // starts at line 1
      expect(headers[1]?.hiddenLineCount).toBe(6); // 10 - (1 + 4) = 5... wait: 1+3=4, next starts at 10, gap=10-4=6
    });

    it("sets hiddenLineCount to 0 for adjacent hunks with no gap", () => {
      const diff = `@@ -1,5 +1,5 @@
 a
 b
-c
+d
 e
 f
@@ -6,3 +6,3 @@
 g
-h
+i`;
      const lines = parseDiffLines(diff);
      const headers = lines.filter((l) => l.type === "header" && l.content.startsWith("@@"));
      expect(headers[0]?.hiddenLineCount).toBe(0);
      expect(headers[1]?.hiddenLineCount).toBe(0); // 6 - (1+5) = 0
    });

    it("handles single-line hunk header with no count (defaults to 1)", () => {
      const diff = `@@ -5 +5 @@
-old
+new`;
      const lines = parseDiffLines(diff);
      const header = lines.find((l) => l.type === "header" && l.content.startsWith("@@"));
      expect(header?.hiddenLineCount).toBe(4); // 5 - 1 = 4 lines hidden before
    });

    it("clamps hiddenLineCount to 0 for new-file diffs (oldStart=0)", () => {
      const diff = `@@ -0,0 +1,3 @@
+line1
+line2
+line3`;
      const lines = parseDiffLines(diff);
      const header = lines.find((l) => l.type === "header" && l.content.startsWith("@@"));
      expect(header?.hiddenLineCount).toBe(0);
    });

    it("does not set hiddenLineCount on git metadata headers", () => {
      const diff = `diff --git a/foo.ts b/foo.ts
index abc..def 100644
--- a/foo.ts
+++ b/foo.ts
@@ -1,2 +1,2 @@
-old
+new`;
      const lines = parseDiffLines(diff);
      const metaHeaders = lines.filter(
        (l) => l.type === "header" && !l.content.startsWith("@@"),
      );
      for (const h of metaHeaders) {
        expect(h.hiddenLineCount).toBeUndefined();
      }
    });

    it("resets hiddenLineCount tracking on new file section in multi-file diff", () => {
      // Second file's first hunk should be relative to that file, not the previous one
      const diff = `diff --git a/a.ts b/a.ts
@@ -5,2 +5,2 @@
-old
+new
diff --git a/b.ts b/b.ts
@@ -3,2 +3,2 @@
-old2
+new2`;
      const lines = parseDiffLines(diff);
      const hunkHeaders = lines.filter(
        (l) => l.type === "header" && l.content.startsWith("@@"),
      );
      expect(hunkHeaders[0]?.hiddenLineCount).toBe(4); // first file: 5-1=4
      expect(hunkHeaders[1]?.hiddenLineCount).toBe(2); // second file: reset, 3-1=2
    });
  });

  describe("line number tracking", () => {
    it("tracks old and new line numbers across hunk boundaries", () => {
      const diff = `@@ -1,2 +1,3 @@
 context
+added
 context
@@ -10,2 +11,2 @@
 context2
-removed`;
      const lines = parseDiffLines(diff);
      const contextLines = lines.filter((l) => l.type === "context");
      expect(contextLines[0]?.oldLineNo).toBe(1);
      expect(contextLines[0]?.newLineNo).toBe(1);
      expect(contextLines[2]?.oldLineNo).toBe(10);
      expect(contextLines[2]?.newLineNo).toBe(11);
    });

    it("assigns null oldLineNo to added lines and null newLineNo to removed lines", () => {
      const diff = `@@ -1,2 +1,2 @@
-removed
+added`;
      const lines = parseDiffLines(diff);
      const rem = lines.find((l) => l.type === "remove");
      const add = lines.find((l) => l.type === "add");
      expect(rem?.oldLineNo).toBe(1);
      expect(rem?.newLineNo).toBeNull();
      expect(add?.newLineNo).toBe(1);
      expect(add?.oldLineNo).toBeNull();
    });
  });

  describe("content parsing", () => {
    it("strips leading +/- from add/remove lines", () => {
      const diff = `@@ -1 +1 @@
-const x = 1;
+const x = 2;`;
      const lines = parseDiffLines(diff);
      expect(lines.find((l) => l.type === "remove")?.content).toBe("const x = 1;");
      expect(lines.find((l) => l.type === "add")?.content).toBe("const x = 2;");
    });

    it("strips leading space from context lines", () => {
      const diff = `@@ -1 +1 @@
 unchanged`;
      const lines = parseDiffLines(diff);
      expect(lines.find((l) => l.type === "context")?.content).toBe("unchanged");
    });
  });
});

describe("isMarkdownFile", () => {
  it("returns true for .md extension", () => {
    expect(isMarkdownFile("README.md")).toBe(true);
  });

  it("returns true for .mdx extension", () => {
    expect(isMarkdownFile("docs/guide.mdx")).toBe(true);
  });

  it("returns true for uppercase .MD extension", () => {
    expect(isMarkdownFile("README.MD")).toBe(true);
  });

  it("returns false for .ts file", () => {
    expect(isMarkdownFile("index.ts")).toBe(false);
  });

  it("returns false for .txt file", () => {
    expect(isMarkdownFile("notes.txt")).toBe(false);
  });

  it("returns false for a file with no extension", () => {
    expect(isMarkdownFile("Makefile")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isMarkdownFile("")).toBe(false);
  });

  it("handles path with directories", () => {
    expect(isMarkdownFile("docs/guides/architecture.md")).toBe(true);
  });
});

describe("reconstructNewContent", () => {
  it("returns empty string for empty lines array", () => {
    expect(reconstructNewContent([])).toBe("");
  });

  it("includes context lines", () => {
    const lines = parseDiffLines(`@@ -1,2 +1,2 @@
 first
 second`);
    expect(reconstructNewContent(lines)).toBe("first\nsecond");
  });

  it("includes added lines", () => {
    const lines = parseDiffLines(`@@ -1,1 +1,2 @@
 context
+added`);
    expect(reconstructNewContent(lines)).toBe("context\nadded");
  });

  it("excludes removed lines", () => {
    const lines = parseDiffLines(`@@ -1,2 +1,1 @@
-removed
 kept`);
    expect(reconstructNewContent(lines)).toBe("kept");
  });

  it("excludes header lines", () => {
    const lines = parseDiffLines(`diff --git a/foo.md b/foo.md
--- a/foo.md
+++ b/foo.md
@@ -1,1 +1,1 @@
-old
+new`);
    expect(reconstructNewContent(lines)).toBe("new");
  });

  it("reconstructs correct order: context before add", () => {
    const lines = parseDiffLines(`@@ -1,2 +1,3 @@
 line1
-old
+new
 line3`);
    expect(reconstructNewContent(lines)).toBe("line1\nnew\nline3");
  });

  it("preserves empty lines from context", () => {
    const lines = parseDiffLines(`@@ -1,3 +1,3 @@
 first

 last`);
    expect(reconstructNewContent(lines)).toBe("first\n\nlast");
  });

  it("excludes the no-newline sentinel", () => {
    const lines = parseDiffLines(`@@ -1,1 +1,1 @@
-old
+new
\\ No newline at end of file`);
    expect(reconstructNewContent(lines)).toBe("new");
  });
});
