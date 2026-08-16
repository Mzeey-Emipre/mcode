import { describe, expect, it } from "vitest";
import { sanitizePublicToolInput } from "../public-tool-input.js";

describe("sanitizePublicToolInput", () => {
  it("removes raw file content while preserving attribution metadata", () => {
    expect(sanitizePublicToolInput({
      file_path: "src/a.ts",
      operation: "edit",
      old_string: "secret before",
      new_string: "secret after",
      content: "secret body",
      _mcodeFileMutations: [{ path: "src/a.ts", beforeText: "secret" }],
    }, "Edit")).toEqual({ file_path: "src/a.ts", operation: "edit" });
  });

  it("preserves content fields for non-file tools", () => {
    const input = { content: "Create the task", status: "pending" };
    expect(sanitizePublicToolInput(input, "TaskCreate")).toBe(input);
  });

  it.each(["Move", "mOvE", "Rename", "rEnAmE"])(
    "allowlists public metadata for %s without exposing mutation bodies",
    (toolName) => {
      const sanitized = sanitizePublicToolInput({
        from: "src/old.ts",
        to: "src/new.ts",
        operation: "rename",
        beforeText: "SECRET_BEFORE",
        afterText: "SECRET_AFTER",
        mutation: { beforeText: "SECRET_BEFORE", afterText: "SECRET_AFTER" },
      }, toolName);

      expect(sanitized).toEqual({
        from: "src/old.ts",
        to: "src/new.ts",
        operation: "rename",
      });
      expect(JSON.stringify(sanitized)).not.toContain("SECRET_BEFORE");
      expect(JSON.stringify(sanitized)).not.toContain("SECRET_AFTER");
    },
  );

  it("recognizes source/destination-shaped file input without a tool name", () => {
    const sanitized = sanitizePublicToolInput({
      from: "src/old.ts",
      to: "src/new.ts",
      mutation: { beforeText: "SECRET_BEFORE", afterText: "SECRET_AFTER" },
    });

    expect(sanitized).toEqual({ from: "src/old.ts", to: "src/new.ts" });
    expect(JSON.stringify(sanitized)).not.toContain("SECRET_BEFORE");
    expect(JSON.stringify(sanitized)).not.toContain("SECRET_AFTER");
  });
});
