import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { handleBinaryUpload } from "../transport/binary-upload";
import { existsSync } from "fs";
import { readFile, unlink } from "fs/promises";

describe("handleBinaryUpload", () => {
  it("writes binary data to a temp file and returns attachment metadata", async () => {
    const payload = Buffer.from("hello world");
    const meta = {
      mimeType: "text/plain",
      fileName: "test.txt",
    };

    const result = await handleBinaryUpload(meta, payload);
    try {
      expect(result).toMatchObject({
        id: expect.any(String),
        name: "test.txt",
        mimeType: "text/plain",
        sizeBytes: 11,
        sourcePath: expect.stringContaining("test"),
      });

      // Verify the file was actually written
      expect(existsSync(result.sourcePath)).toBe(true);
      const contents = await readFile(result.sourcePath);
      expect(contents.toString()).toBe("hello world");
    } finally {
      await unlink(result.sourcePath).catch(() => undefined);
    }
  });

  it("rejects files exceeding size limits", async () => {
    // Create a buffer larger than the 1 MB text limit
    const oversized = Buffer.alloc(2 * 1024 * 1024);
    const meta = {
      mimeType: "text/plain",
      fileName: "big.txt",
    };

    await expect(handleBinaryUpload(meta, oversized)).rejects.toThrow(/exceeds.*limit/i);
  });

  it("rejects fileNames with path separators", async () => {
    const payload = Buffer.from("data");
    const meta = {
      mimeType: "text/plain",
      fileName: "../etc/passwd",
    };

    await expect(handleBinaryUpload(meta, payload)).rejects.toThrow(/path separator/i);
  });
});
