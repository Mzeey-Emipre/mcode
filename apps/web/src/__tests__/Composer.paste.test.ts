import { describe, it, expect } from "vitest";
import {
  classifyFile,
  isFileSupported,
  getMaxFileSize,
  inferMimeType,
} from "@mcode/contracts";

function createMockFile(name: string, type: string, size: number): File {
  const content = new Uint8Array(size);
  return new File([content], name, { type });
}

describe("Extension-based file filtering (integration)", () => {
  it.each([
    ["photo.png", true],
    ["app.tsx", true],
    ["config.json", true],
    ["README.md", true],
    ["data.csv", true],
    ["Dockerfile", true],
    ["archive.zip", false],
    ["randomfile", false],
  ])("isFileSupported(%s) = %s", (name, expected) => {
    expect(isFileSupported(name)).toBe(expected);
  });

  it("handles browser File objects with empty MIME types", () => {
    const file = createMockFile("app.ts", "", 1024);
    expect(isFileSupported(file.name)).toBe(true);
  });
});

describe("Size validation", () => {
  it.each([
    ["photo.png", 20 * 1024 * 1024],
    ["doc.pdf", 32 * 1024 * 1024],
    ["app.ts", 10 * 1024 * 1024],
    ["archive.zip", 0],
  ])("getMaxFileSize(%s) = %d", (name, expected) => {
    expect(getMaxFileSize(name)).toBe(expected);
  });
});

describe("MIME type inference", () => {
  it.each([
    ["photo.png", "image/png"],
    ["doc.pdf", "application/pdf"],
    ["app.ts", "text/plain"],
    ["config.json", "text/plain"],
  ])("inferMimeType(%s) = %s", (name, expected) => {
    expect(inferMimeType(name)).toBe(expected);
  });
});

describe("Path partitioning logic", () => {
  it("partitions files into with-path and without-path groups", () => {
    const files = [
      createMockFile("a.png", "image/png", 100),
      createMockFile("b.json", "application/json", 100),
      createMockFile("c.ts", "", 100),
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
    expect(withoutPaths.map((f) => f.name)).toEqual(["b.json", "c.ts"]);
  });

  it("classifies images vs non-images for routing", () => {
    expect(classifyFile("screenshot.png")).toBe("image");
    expect(classifyFile("data.json")).toBe("text");
    expect(classifyFile("doc.pdf")).toBe("pdf");
  });
});
