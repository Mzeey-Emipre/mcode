import { describe, expect, it } from "vitest";
import { normalizeMcodeCursorToolInput } from "../cursor-tool-input-normalize.js";

describe("normalizeMcodeCursorToolInput", () => {
  it("maps Cursor edit aliases to snake_case render fields", () => {
    expect(
      normalizeMcodeCursorToolInput("Edit", {
        path: "src/foo.ts",
        search: "// old\n",
        replace: "// new\n",
      }),
    ).toMatchObject({
      file_path: "src/foo.ts",
      old_string: "// old\n",
      new_string: "// new\n",
    });
  });

  it("maps Write aliases (path, contents) to renderer fields", () => {
    expect(
      normalizeMcodeCursorToolInput("Write", {
        path: "README.md",
        contents: "hello",
      }),
    ).toMatchObject({
      file_path: "README.md",
      content: "hello",
    });
  });

  it("passes through unrelated tools untouched", () => {
    expect(normalizeMcodeCursorToolInput("Read", { file_path: "x" })).toEqual({
      file_path: "x",
    });
  });
});
