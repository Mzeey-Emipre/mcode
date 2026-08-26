import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildCursorPrompt, readCursorUserInstructions } from "../cursor-prompt.js";

describe("cursor-prompt", () => {
  describe("readCursorUserInstructions", () => {
    let originalHome: string | undefined;
    let originalUserProfile: string | undefined;
    let fakeHome: string;

    beforeEach(() => {
      fakeHome = mkdtempSync(join(tmpdir(), "cursor-prompt-"));
      originalHome = process.env.HOME;
      originalUserProfile = process.env.USERPROFILE;
      process.env.HOME = fakeHome;
      process.env.USERPROFILE = fakeHome;
    });

    afterEach(() => {
      if (originalHome !== undefined) process.env.HOME = originalHome;
      else delete process.env.HOME;
      if (originalUserProfile !== undefined) process.env.USERPROFILE = originalUserProfile;
      else delete process.env.USERPROFILE;
      rmSync(fakeHome, { recursive: true, force: true });
    });

    it("returns undefined when ~/.cursor/AGENTS.md is absent", () => {
      expect(readCursorUserInstructions()).toBeUndefined();
    });

    it("returns trimmed contents when ~/.cursor/AGENTS.md exists", () => {
      const agentsPath = join(fakeHome, ".cursor", "AGENTS.md");
      mkdirSync(join(fakeHome, ".cursor"), { recursive: true });
      writeFileSync(agentsPath, "  Stay concise.\n\n", "utf-8");

      expect(readCursorUserInstructions()).toBe("Stay concise.");
    });

    it("returns undefined when file is whitespace-only", () => {
      const agentsPath = join(fakeHome, ".cursor", "AGENTS.md");
      mkdirSync(join(fakeHome, ".cursor"), { recursive: true });
      writeFileSync(agentsPath, "   \n\t\n", "utf-8");

      expect(readCursorUserInstructions()).toBeUndefined();
    });
  });

  describe("buildCursorPrompt", () => {
    it("concatenates attachments and message without instructions block when omitted", () => {
      const prompt = buildCursorPrompt("hello", [
        {
          id: "a1",
          name: "x.txt",
          mimeType: "text/plain",
          sizeBytes: 1,
          sourcePath: "/tmp/x.txt",
        },
      ]);
      expect(prompt).toBe("[Attached file: x.txt (text/plain)]\n\nhello");
      expect(prompt).not.toContain("<user-instructions>");
    });

    it("prepends user-instructions wrapper when instructions are provided", () => {
      const prompt = buildCursorPrompt("do work", undefined, "Always cite paths.");
      expect(prompt.startsWith("<user-instructions>\nAlways cite paths.\n</user-instructions>")).toBe(
        true,
      );
      expect(prompt.endsWith("\n\ndo work")).toBe(true);
    });
  });
});
