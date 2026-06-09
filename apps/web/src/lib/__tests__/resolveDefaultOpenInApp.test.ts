import { describe, it, expect } from "vitest";
import {
  resolveDefaultOpenInApp,
  FILE_EXPLORER_ID,
} from "../resolveDefaultOpenInApp";
import type { OpenInApp } from "@/transport/types";

/** Build an OpenInApp with sensible defaults for resolution tests. */
function app(overrides: Partial<OpenInApp> & Pick<OpenInApp, "id">): OpenInApp {
  return {
    label: overrides.id,
    kind: "editor",
    iconKey: overrides.id,
    detected: true,
    ...overrides,
  };
}

const vscode = app({ id: "code", label: "VS Code", kind: "editor" });
const cursor = app({ id: "cursor", label: "Cursor", kind: "editor" });
const zed = app({ id: "zed", label: "Zed", kind: "editor" });
const explorer = app({
  id: FILE_EXPLORER_ID,
  label: "File Explorer",
  kind: "fileManager",
});

/** Registration order mirrors the desktop registry: editors then File Explorer. */
const allInstalled = [vscode, cursor, zed, explorer];

describe("resolveDefaultOpenInApp", () => {
  describe("tier 1: thread override", () => {
    it("returns the thread override when that app is installed", () => {
      expect(resolveDefaultOpenInApp("zed", "code", allInstalled)).toBe("zed");
    });

    it("wins over the global default", () => {
      expect(resolveDefaultOpenInApp("cursor", "code", allInstalled)).toBe("cursor");
    });

    it("falls through when the override app is not installed", () => {
      const installed = [vscode, explorer];
      expect(resolveDefaultOpenInApp("zed", null, installed)).toBe("code");
    });

    it("falls through when the override app is present but not detected", () => {
      const installed = [{ ...zed, detected: false }, vscode, explorer];
      expect(resolveDefaultOpenInApp("zed", null, installed)).toBe("code");
    });
  });

  describe("tier 2: global default", () => {
    it("is used when there is no thread override", () => {
      expect(resolveDefaultOpenInApp(null, "cursor", allInstalled)).toBe("cursor");
    });

    it("treats an empty-string global default as unset", () => {
      expect(resolveDefaultOpenInApp(null, "", allInstalled)).toBe("code");
    });

    it("falls through when the global default app is not installed", () => {
      const installed = [cursor, explorer];
      expect(resolveDefaultOpenInApp(null, "code", installed)).toBe("cursor");
    });
  });

  describe("tier 3: auto-resolve editor priority order", () => {
    it("picks the first editor in registration order (VS Code > Cursor > Zed)", () => {
      expect(resolveDefaultOpenInApp(null, null, allInstalled)).toBe("code");
    });

    it("picks Cursor when VS Code is absent", () => {
      expect(resolveDefaultOpenInApp(null, null, [cursor, zed, explorer])).toBe("cursor");
    });

    it("picks Zed when only Zed and Explorer are installed", () => {
      expect(resolveDefaultOpenInApp(null, null, [zed, explorer])).toBe("zed");
    });

    it("skips an undetected editor and picks the next detected one", () => {
      const installed = [{ ...vscode, detected: false }, cursor, explorer];
      expect(resolveDefaultOpenInApp(null, null, installed)).toBe("cursor");
    });
  });

  describe("File Explorer fallback", () => {
    it("falls back to File Explorer when no editor is installed", () => {
      expect(resolveDefaultOpenInApp(null, null, [explorer])).toBe(FILE_EXPLORER_ID);
    });

    it("falls back to a file manager even when no editor is detected", () => {
      const installed = [{ ...vscode, detected: false }, explorer];
      expect(resolveDefaultOpenInApp(null, null, installed)).toBe(FILE_EXPLORER_ID);
    });
  });

  describe("empty installed list", () => {
    it("returns the File Explorer id constant", () => {
      expect(resolveDefaultOpenInApp(null, null, [])).toBe(FILE_EXPLORER_ID);
    });

    it("ignores override and global default when nothing is installed", () => {
      expect(resolveDefaultOpenInApp("code", "cursor", [])).toBe(FILE_EXPLORER_ID);
    });
  });
});
