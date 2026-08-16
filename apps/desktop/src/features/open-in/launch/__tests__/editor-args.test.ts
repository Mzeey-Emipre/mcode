import { describe, it, expect } from "vitest";
import { buildEditorArgs } from "../editor-args";

describe("buildEditorArgs", () => {
  it("returns [path] when no line is provided", () => {
    expect(buildEditorArgs("code", "/abs/file.ts")).toEqual(["/abs/file.ts"]);
    expect(buildEditorArgs("cursor", "/abs/file.ts")).toEqual(["/abs/file.ts"]);
    expect(buildEditorArgs("zed", "/abs/file.ts")).toEqual(["/abs/file.ts"]);
  });

  it("VS Code uses -g <path>:<line> when a line is provided", () => {
    expect(buildEditorArgs("code", "/abs/file.ts", 42)).toEqual(["-g", "/abs/file.ts:42"]);
  });

  it("Cursor uses -g <path>:<line> when a line is provided", () => {
    expect(buildEditorArgs("cursor", "/abs/file.ts", 42)).toEqual(["-g", "/abs/file.ts:42"]);
  });

  it("Zed uses <path>:<line> with no flag", () => {
    expect(buildEditorArgs("zed", "/abs/file.ts", 42)).toEqual(["/abs/file.ts:42"]);
  });

  it("Visual Studio opens the path as-is, ignoring any line (no folder-mode goto flag)", () => {
    expect(buildEditorArgs("vs", "/abs/file.ts")).toEqual(["/abs/file.ts"]);
    expect(buildEditorArgs("vs", "/abs/file.ts", 42)).toEqual(["/abs/file.ts"]);
  });

  it("ignores non-positive or non-finite line numbers", () => {
    expect(buildEditorArgs("code", "/abs/file.ts", 0)).toEqual(["/abs/file.ts"]);
    expect(buildEditorArgs("code", "/abs/file.ts", -5)).toEqual(["/abs/file.ts"]);
    expect(buildEditorArgs("code", "/abs/file.ts", Number.NaN)).toEqual(["/abs/file.ts"]);
  });

  it("works on Windows paths with backslashes and spaces", () => {
    const winPath = String.raw`C:\Users\me\My Project\src\file.ts`;
    expect(buildEditorArgs("code", winPath, 12)).toEqual(["-g", `${winPath}:12`]);
  });
});
