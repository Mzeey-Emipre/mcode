import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AttachmentService } from "../attachment-service.js";
import {
  MCODE_BROWSER_CONTEXT_ATTACHMENT_MIME,
  type AttachmentMeta,
} from "@mcode/contracts";

describe("AttachmentService.persist virtual browser context", () => {
  it("records stored metadata without copying a file", async () => {
    const svc = new AttachmentService();
    const att: AttachmentMeta = {
      id: "ctx-virtual-001",
      name: "Page context",
      mimeType: MCODE_BROWSER_CONTEXT_ATTACHMENT_MIME,
      sizeBytes: 0,
      sourcePath: "",
    };
    const { stored, persisted } = await svc.persist("thread-unit-test-virtual", [att]);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.mimeType).toBe(MCODE_BROWSER_CONTEXT_ATTACHMENT_MIME);
    expect(stored[0]?.sizeBytes).toBe(0);
    expect(persisted).toHaveLength(0);
  });

  it("normalizes Page context fence-only rows when MIME is missing", async () => {
    const svc = new AttachmentService();
    const att: AttachmentMeta = {
      id: "ctx-fallback-002",
      name: "Page context",
      mimeType: "application/octet-stream",
      sizeBytes: 0,
      sourcePath: "",
    };
    const { stored, persisted } = await svc.persist("thread-unit-test-virtual-fallback", [att]);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.mimeType).toBe(MCODE_BROWSER_CONTEXT_ATTACHMENT_MIME);
    expect(persisted).toHaveLength(0);
  });
});

describe("AttachmentService.persistGeneratedImageFromPath", () => {
  it("copies a generated image and returns stored metadata only", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "mcode-generated-image-"));
    const sourcePath = join(tempDir, "generated.png");
    writeFileSync(sourcePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const svc = new AttachmentService();

    try {
      const stored = svc.persistGeneratedImageFromPath("thread-unit-test-generated", sourcePath);

      expect(stored.name).toBe("generated.png");
      expect(stored.mimeType).toBe("image/png");
      expect(stored.sizeBytes).toBe(4);
      expect(stored).not.toHaveProperty("sourcePath");
      expect(existsSync(sourcePath)).toBe(true);
    } finally {
      svc.removeForThread("thread-unit-test-generated");
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
