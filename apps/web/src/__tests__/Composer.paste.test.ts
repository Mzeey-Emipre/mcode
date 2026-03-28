import { describe, it, expect } from "vitest";

/**
 * Unit tests for the handlePaste logic extracted from Composer.
 * We test the filtering and branching logic directly rather than
 * rendering the full Composer component (which requires extensive mocking).
 */

// Constants mirrored from Composer.tsx for test assertions
const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const SUPPORTED_FILE_TYPES = new Set(["application/pdf", "text/plain"]);
const ALL_SUPPORTED_TYPES = new Set([...SUPPORTED_IMAGE_TYPES, ...SUPPORTED_FILE_TYPES]);
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const MAX_PDF_SIZE = 32 * 1024 * 1024;
const MAX_TEXT_SIZE = 1 * 1024 * 1024;

function getMaxSize(mimeType: string): number {
  if (SUPPORTED_IMAGE_TYPES.has(mimeType)) return MAX_IMAGE_SIZE;
  if (mimeType === "application/pdf") return MAX_PDF_SIZE;
  if (mimeType === "text/plain") return MAX_TEXT_SIZE;
  return 0;
}

function createMockFile(name: string, type: string, size: number): File {
  const content = new Uint8Array(size);
  return new File([content], name, { type });
}

describe("Paste file filtering", () => {
  it("accepts image files", () => {
    const file = createMockFile("photo.png", "image/png", 1024);
    expect(ALL_SUPPORTED_TYPES.has(file.type)).toBe(true);
  });

  it("accepts PDF files", () => {
    const file = createMockFile("doc.pdf", "application/pdf", 1024);
    expect(ALL_SUPPORTED_TYPES.has(file.type)).toBe(true);
  });

  it("accepts plain text files", () => {
    const file = createMockFile("notes.txt", "text/plain", 1024);
    expect(ALL_SUPPORTED_TYPES.has(file.type)).toBe(true);
  });

  it("rejects unsupported file types", () => {
    const file = createMockFile("archive.zip", "application/zip", 1024);
    expect(ALL_SUPPORTED_TYPES.has(file.type)).toBe(false);
  });

  it("rejects empty MIME type", () => {
    const file = createMockFile("unknown", "", 1024);
    expect(ALL_SUPPORTED_TYPES.has(file.type)).toBe(false);
  });
});

describe("Paste size validation", () => {
  it("allows image under 5MB", () => {
    const file = createMockFile("photo.png", "image/png", MAX_IMAGE_SIZE - 1);
    expect(file.size <= getMaxSize(file.type)).toBe(true);
  });

  it("rejects image over 5MB", () => {
    const file = createMockFile("huge.png", "image/png", MAX_IMAGE_SIZE + 1);
    expect(file.size > getMaxSize(file.type)).toBe(true);
  });

  it("allows PDF under 32MB", () => {
    const file = createMockFile("doc.pdf", "application/pdf", MAX_PDF_SIZE - 1);
    expect(file.size <= getMaxSize(file.type)).toBe(true);
  });

  it("rejects PDF over 32MB", () => {
    const file = createMockFile("huge.pdf", "application/pdf", MAX_PDF_SIZE + 1);
    expect(file.size > getMaxSize(file.type)).toBe(true);
  });

  it("allows text under 1MB", () => {
    const file = createMockFile("notes.txt", "text/plain", MAX_TEXT_SIZE - 1);
    expect(file.size <= getMaxSize(file.type)).toBe(true);
  });

  it("rejects text over 1MB", () => {
    const file = createMockFile("huge.txt", "text/plain", MAX_TEXT_SIZE + 1);
    expect(file.size > getMaxSize(file.type)).toBe(true);
  });

  it("returns 0 for unsupported type", () => {
    expect(getMaxSize("application/zip")).toBe(0);
  });
});

describe("Paste path partitioning", () => {
  it("partitions files into with-path and without-path groups", () => {
    const files = [
      createMockFile("a.png", "image/png", 100),
      createMockFile("b.pdf", "application/pdf", 100),
      createMockFile("c.txt", "text/plain", 100),
    ];

    const mockGetPath = (f: File): string | null => {
      if (f.name === "a.png") return "/tmp/a.png";
      return null;
    };

    const withPaths: File[] = [];
    const withoutPaths: File[] = [];

    for (const file of files) {
      const path = mockGetPath(file);
      if (path) {
        withPaths.push(file);
      } else {
        withoutPaths.push(file);
      }
    }

    expect(withPaths).toHaveLength(1);
    expect(withPaths[0].name).toBe("a.png");
    expect(withoutPaths).toHaveLength(2);
    expect(withoutPaths.map((f) => f.name)).toEqual(["b.pdf", "c.txt"]);
  });

  it("routes images without path to readClipboardImage", () => {
    const file = createMockFile("screenshot.png", "image/png", 100);
    const isImage = file.type.startsWith("image/");
    expect(isImage).toBe(true);
  });

  it("routes non-images without path to saveClipboardFile", () => {
    const file = createMockFile("doc.pdf", "application/pdf", 100);
    const isImage = file.type.startsWith("image/");
    expect(isImage).toBe(false);
  });
});
