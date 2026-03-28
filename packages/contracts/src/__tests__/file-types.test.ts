import { describe, it, expect } from "vitest";
import {
  classifyFile,
  getMaxFileSize,
  isFileSupported,
  getExtension,
  inferMimeType,
} from "../models/file-types.js";

describe("getExtension", () => {
  it("extracts extension from filename", () => {
    expect(getExtension("app.tsx")).toBe("tsx");
  });

  it("extracts extension from dotfile", () => {
    expect(getExtension(".gitignore")).toBe("gitignore");
  });

  it("handles double extensions (takes last)", () => {
    expect(getExtension("data.test.ts")).toBe("ts");
  });

  it("returns empty string for no extension", () => {
    expect(getExtension("Makefile")).toBe("");
  });

  it("lowercases the extension", () => {
    expect(getExtension("README.MD")).toBe("md");
  });
});

describe("classifyFile", () => {
  it("classifies image files", () => {
    expect(classifyFile("photo.png")).toBe("image");
    expect(classifyFile("pic.jpeg")).toBe("image");
    expect(classifyFile("icon.webp")).toBe("image");
    expect(classifyFile("anim.gif")).toBe("image");
  });

  it("classifies PDF files", () => {
    expect(classifyFile("doc.pdf")).toBe("pdf");
  });

  it("classifies code files", () => {
    expect(classifyFile("app.ts")).toBe("text");
    expect(classifyFile("main.go")).toBe("text");
    expect(classifyFile("lib.rs")).toBe("text");
    expect(classifyFile("styles.css")).toBe("text");
  });

  it("classifies config files", () => {
    expect(classifyFile("config.json")).toBe("text");
    expect(classifyFile("settings.yaml")).toBe("text");
    expect(classifyFile("pyproject.toml")).toBe("text");
    expect(classifyFile(".env")).toBe("text");
  });

  it("classifies doc files", () => {
    expect(classifyFile("README.md")).toBe("text");
    expect(classifyFile("notes.txt")).toBe("text");
    expect(classifyFile("changes.rst")).toBe("text");
  });

  it("classifies data files", () => {
    expect(classifyFile("data.csv")).toBe("text");
    expect(classifyFile("query.sql")).toBe("text");
    expect(classifyFile("schema.graphql")).toBe("text");
  });

  it("classifies shell scripts", () => {
    expect(classifyFile("deploy.sh")).toBe("text");
    expect(classifyFile("setup.ps1")).toBe("text");
    expect(classifyFile("run.bat")).toBe("text");
  });

  it("classifies web component files", () => {
    expect(classifyFile("App.vue")).toBe("text");
    expect(classifyFile("Page.svelte")).toBe("text");
    expect(classifyFile("Layout.astro")).toBe("text");
  });

  it("classifies devops files", () => {
    expect(classifyFile("main.tf")).toBe("text");
    expect(classifyFile("config.hcl")).toBe("text");
    expect(classifyFile("shell.nix")).toBe("text");
  });

  it("classifies diff/patch files", () => {
    expect(classifyFile("fix.diff")).toBe("text");
    expect(classifyFile("update.patch")).toBe("text");
  });

  it("returns null for unsupported extensions", () => {
    expect(classifyFile("archive.zip")).toBeNull();
    expect(classifyFile("video.mp4")).toBeNull();
    expect(classifyFile("binary.exe")).toBeNull();
  });

  it("returns null for extensionless files without known names", () => {
    expect(classifyFile("randomfile")).toBeNull();
  });

  it("classifies well-known extensionless filenames", () => {
    expect(classifyFile("Dockerfile")).toBe("text");
    expect(classifyFile("Makefile")).toBe("text");
    expect(classifyFile("Rakefile")).toBe("text");
    expect(classifyFile("Gemfile")).toBe("text");
    expect(classifyFile("Justfile")).toBe("text");
    expect(classifyFile("Containerfile")).toBe("text");
  });
});

describe("isFileSupported", () => {
  it("returns true for supported extensions", () => {
    expect(isFileSupported("app.tsx")).toBe(true);
    expect(isFileSupported("photo.png")).toBe(true);
    expect(isFileSupported("doc.pdf")).toBe(true);
  });

  it("returns false for unsupported extensions", () => {
    expect(isFileSupported("archive.zip")).toBe(false);
    expect(isFileSupported("video.mp4")).toBe(false);
  });
});

describe("getMaxFileSize", () => {
  it("returns 20MB for images", () => {
    expect(getMaxFileSize("photo.png")).toBe(20 * 1024 * 1024);
  });

  it("returns 32MB for PDFs", () => {
    expect(getMaxFileSize("doc.pdf")).toBe(32 * 1024 * 1024);
  });

  it("returns 10MB for text/code files", () => {
    expect(getMaxFileSize("app.ts")).toBe(10 * 1024 * 1024);
  });

  it("returns 0 for unsupported files", () => {
    expect(getMaxFileSize("archive.zip")).toBe(0);
  });
});

describe("inferMimeType", () => {
  it("infers image MIME types", () => {
    expect(inferMimeType("photo.png")).toBe("image/png");
    expect(inferMimeType("pic.jpg")).toBe("image/jpeg");
    expect(inferMimeType("pic.jpeg")).toBe("image/jpeg");
    expect(inferMimeType("icon.gif")).toBe("image/gif");
    expect(inferMimeType("icon.webp")).toBe("image/webp");
  });

  it("infers PDF MIME type", () => {
    expect(inferMimeType("doc.pdf")).toBe("application/pdf");
  });

  it("returns text/plain for code and text files", () => {
    expect(inferMimeType("app.ts")).toBe("text/plain");
    expect(inferMimeType("config.json")).toBe("text/plain");
    expect(inferMimeType("README.md")).toBe("text/plain");
  });

  it("returns empty string for unsupported", () => {
    expect(inferMimeType("archive.zip")).toBe("");
  });
});
