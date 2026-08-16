import { describe, it, expect } from "vitest";
import { collectSpillPathsFromPendingAttachments } from "../browser-capture-spill";
import type { PendingAttachment } from "@/components/chat/AttachmentPreview";

describe("collectSpillPathsFromPendingAttachments", () => {
  it("collects spillAppDataPath from v2 browserCapture on pending attachments", () => {
    const spill = "browser-capture-spill/ws/550e8400-e29b-41d4-b716-446655440000.json";
    const att: PendingAttachment = {
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      name: "ctx",
      mimeType: "application/x-mcode-browser-context",
      sizeBytes: 0,
      previewUrl: "",
      filePath: null,
      contextOnly: true,
      browserCapture: {
        schemaVersion: 2,
        pageUrl: "https://example.com",
        pageTitle: "Ex",
        capturedAt: "2026-05-08T12:00:00.000Z",
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        spillAppDataPath: spill,
      },
    };
    expect(collectSpillPathsFromPendingAttachments([att])).toEqual([spill]);
  });

  it("ignores attachments without v2 spill", () => {
    const att: PendingAttachment = {
      id: "b",
      name: "x.png",
      mimeType: "image/png",
      sizeBytes: 1,
      previewUrl: "blob:x",
      filePath: null,
    };
    expect(collectSpillPathsFromPendingAttachments([att])).toEqual([]);
  });
});
