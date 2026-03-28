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

describe("Extension-based file filtering", () => {
  it("accepts image files by extension", () => {
    expect(isFileSupported("photo.png")).toBe(true);
    expect(isFileSupported("pic.jpeg")).toBe(true);
    expect(isFileSupported("icon.gif")).toBe(true);
    expect(isFileSupported("hero.webp")).toBe(true);
  });

  it("accepts PDF files", () => {
    expect(isFileSupported("doc.pdf")).toBe(true);
  });

  it("accepts common code files", () => {
    expect(isFileSupported("app.ts")).toBe(true);
    expect(isFileSupported("app.tsx")).toBe(true);
    expect(isFileSupported("main.py")).toBe(true);
    expect(isFileSupported("lib.go")).toBe(true);
    expect(isFileSupported("mod.rs")).toBe(true);
    expect(isFileSupported("App.java")).toBe(true);
    expect(isFileSupported("Program.cs")).toBe(true);
  });

  it("accepts config files", () => {
    expect(isFileSupported("package.json")).toBe(true);
    expect(isFileSupported("config.yaml")).toBe(true);
    expect(isFileSupported("settings.toml")).toBe(true);
    expect(isFileSupported(".env")).toBe(true);
  });

  it("accepts documentation files", () => {
    expect(isFileSupported("README.md")).toBe(true);
    expect(isFileSupported("notes.txt")).toBe(true);
    expect(isFileSupported("docs.rst")).toBe(true);
  });

  it("accepts data files", () => {
    expect(isFileSupported("data.csv")).toBe(true);
    expect(isFileSupported("query.sql")).toBe(true);
    expect(isFileSupported("schema.graphql")).toBe(true);
  });

  it("accepts well-known extensionless filenames", () => {
    expect(isFileSupported("Dockerfile")).toBe(true);
    expect(isFileSupported("Makefile")).toBe(true);
  });

  it("rejects unsupported file types", () => {
    expect(isFileSupported("archive.zip")).toBe(false);
    expect(isFileSupported("video.mp4")).toBe(false);
    expect(isFileSupported("binary.exe")).toBe(false);
    expect(isFileSupported("database.sqlite")).toBe(false);
  });

  it("rejects unknown extensionless files", () => {
    expect(isFileSupported("randomfile")).toBe(false);
  });

  it("handles browser File objects with empty MIME types", () => {
    // Browsers return empty type for .ts, .go, .rs, etc.
    const file = createMockFile("app.ts", "", 1024);
    expect(isFileSupported(file.name)).toBe(true);
  });
});

describe("Size validation", () => {
  it("allows images up to 20MB", () => {
    const limit = getMaxFileSize("photo.png");
    expect(limit).toBe(20 * 1024 * 1024);
  });

  it("allows PDFs up to 32MB", () => {
    const limit = getMaxFileSize("doc.pdf");
    expect(limit).toBe(32 * 1024 * 1024);
  });

  it("allows text/code files up to 10MB", () => {
    const limit = getMaxFileSize("app.ts");
    expect(limit).toBe(10 * 1024 * 1024);
  });

  it("returns 0 for unsupported files", () => {
    expect(getMaxFileSize("archive.zip")).toBe(0);
  });
});

describe("MIME type inference", () => {
  it("infers correct MIME for images", () => {
    expect(inferMimeType("photo.png")).toBe("image/png");
    expect(inferMimeType("photo.jpg")).toBe("image/jpeg");
  });

  it("infers application/pdf for PDFs", () => {
    expect(inferMimeType("doc.pdf")).toBe("application/pdf");
  });

  it("infers text/plain for code files", () => {
    expect(inferMimeType("app.ts")).toBe("text/plain");
    expect(inferMimeType("config.json")).toBe("text/plain");
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

  it("routes images without path to readClipboardImage", () => {
    expect(classifyFile("screenshot.png")).toBe("image");
  });

  it("routes non-images without path to saveClipboardFile", () => {
    expect(classifyFile("data.json")).toBe("text");
    expect(classifyFile("doc.pdf")).toBe("pdf");
  });
});
