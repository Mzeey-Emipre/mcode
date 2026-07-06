import { describe, expect, it } from "vitest";
import {
  MAX_ATTACHMENTS,
  PreviewAnnotationBundleSchema,
  SendMessageSchema,
  previewAnnotationSnapshotAttachmentMeta,
  previewAnnotationSnapshotStoredAttachment,
} from "../../index.js";

const capture = {
  schemaVersion: 2 as const,
  pageUrl: "http://localhost:5173/products/1",
  pageTitle: "Product",
  capturedAt: "2026-07-01T00:00:00.000Z",
  captureKind: "element" as const,
  selectorHint: "button.buy",
  bounds: { x: 10, y: 20, width: 100, height: 40 },
  visibleTextExcerpt: "Buy now",
  layoutViewport: { width: 1200, height: 800 },
};

const annotation = {
  id: "00000000-0000-4000-8000-000000000001",
  displayNumber: 1,
  pageIdentity: "http://localhost:5173/products/1",
  pageContext: capture,
  targetContext: {
    label: "button.buy",
    selectorHint: "button.buy",
    bounds: { x: 10, y: 20, width: 100, height: 40 },
  },
  note: "Make the button clearer.",
  snapshot: {
    id: "snap-1",
    name: "preview.png",
    mimeType: "image/png" as const,
    sizeBytes: 123,
    sourcePath: "C:/tmp/preview.png",
    capture,
  },
};

describe("PreviewAnnotationBundleSchema", () => {
  it("accepts a bounded annotation payload", () => {
    expect(
      PreviewAnnotationBundleSchema().safeParse({
        schemaVersion: 1,
        annotations: [annotation],
      }).success,
    ).toBe(true);
  });

  it("rejects annotations without note or proposed changes", () => {
    const result = PreviewAnnotationBundleSchema().safeParse({
      schemaVersion: 1,
      annotations: [{ ...annotation, note: undefined, changeSummary: undefined }],
    });
    expect(result.success).toBe(false);
  });

  it("does not count annotation snapshots against normal attachment limits", () => {
    const attachments = Array.from({ length: MAX_ATTACHMENTS }, (_, index) => ({
      id: `att-${index}`,
      name: `file-${index}.txt`,
      mimeType: "text/plain",
      sizeBytes: 1,
      sourcePath: `C:/tmp/file-${index}.txt`,
    }));

    const result = SendMessageSchema().safeParse({
      threadId: "thread-1",
      content: "fix this",
      attachments,
      previewAnnotations: { schemaVersion: 1, annotations: [annotation] },
    });

    expect(result.success).toBe(true);
  });

  it("derives image attachment metadata from the annotation snapshot", () => {
    expect(previewAnnotationSnapshotAttachmentMeta(annotation)).toEqual({
      id: "snap-1",
      name: "Annotation 1 screenshot.png",
      mimeType: "image/png",
      sizeBytes: 123,
      sourcePath: "C:/tmp/preview.png",
    });
    expect(previewAnnotationSnapshotStoredAttachment(annotation)).toEqual({
      id: "snap-1",
      name: "Annotation 1 screenshot.png",
      mimeType: "image/png",
      sizeBytes: 123,
    });
  });
});
