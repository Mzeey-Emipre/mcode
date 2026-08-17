import { describe, it, expect } from "vitest";
import { BinaryUploadHeaderSchema } from "@mcode/contracts";

describe("BinaryUploadHeader parsing", () => {
  it("parses a valid binary upload header", () => {
    const header = {
      type: "binary-upload",
      id: "req_1",
      method: "clipboard.saveFile",
      meta: { mimeType: "text/plain", fileName: "test.txt" },
    };
    const result = BinaryUploadHeaderSchema.safeParse(header);
    expect(result.success).toBe(true);
  });

  it("rejects a header with missing fields", () => {
    const header = { type: "binary-upload", id: "req_1" };
    const result = BinaryUploadHeaderSchema.safeParse(header);
    expect(result.success).toBe(false);
  });

  it("rejects a header with wrong type literal", () => {
    const header = {
      type: "push",
      id: "req_1",
      method: "clipboard.saveFile",
      meta: {},
    };
    const result = BinaryUploadHeaderSchema.safeParse(header);
    expect(result.success).toBe(false);
  });
});
