import "reflect-metadata";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { HandoffStorage } from "../handoff-storage.js";
import type { HandoffArtifact } from "../handoff-types.js";

let dir: string;
let storage: HandoffStorage;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "handoff-store-"));
  storage = HandoffStorage.forTesting({ mcodeDirFn: () => dir });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeArtifact(overrides: Partial<HandoffArtifact["meta"]> = {}): HandoffArtifact {
  return {
    markdown: "# Handoff\n\n## Goal\nTest the storage layer.",
    meta: {
      schemaVersion: 1,
      parentThreadId: "t_parent",
      forkedFromMessageId: "m_1",
      forkAnchorRole: "assistant",
      childThreadId: "t_child",
      generatedBy: "provider",
      provider: "claude",
      ladderStep: "B",
      mode: "full",
      generatedAt: new Date().toISOString(),
      characterCount: 50,
      parentSdkSessionId: "sdk_123",
      providerErrorOnGenerate: null,
      regenerationHistory: [],
      attachments: [],
      ...overrides,
    },
  };
}

describe("HandoffStorage", () => {
  it("write creates handoffs/<ulid>/handoff.md and handoff.json", async () => {
    const a = makeArtifact();
    const ulid = await storage.write("t_child", a);
    expect(existsSync(join(dir, "threads", "t_child", "handoffs", ulid, "handoff.md"))).toBe(true);
    expect(existsSync(join(dir, "threads", "t_child", "handoffs", ulid, "handoff.json"))).toBe(true);
  });

  it("write injects YAML frontmatter into the markdown", async () => {
    const a = makeArtifact();
    const ulid = await storage.write("t_child", a);
    const md = readFileSync(join(dir, "threads", "t_child", "handoffs", ulid, "handoff.md"), "utf8");
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain("schemaVersion: 1");
    expect(md).toContain("ladderStep: B");
  });

  it("readLatest returns the highest-ULID handoff for the thread", async () => {
    await storage.write("t_child", makeArtifact({ ladderStep: "D" }));
    await new Promise((r) => setTimeout(r, 10));
    await storage.write("t_child", makeArtifact({ ladderStep: "B" }));
    const latest = await storage.readLatest("t_child");
    expect(latest?.meta.ladderStep).toBe("B");
  });

  it("readLatest returns null when no handoffs exist", async () => {
    expect(await storage.readLatest("t_none")).toBeNull();
  });

  it("copyAttachments duplicates source files into the child's attachments dir", async () => {
    const srcDir = mkdtempSync(join(tmpdir(), "att-src-"));
    const srcFile = join(srcDir, "screenshot.png");
    writeFileSync(srcFile, Buffer.from([1, 2, 3, 4]));

    await storage.copyAttachments("t_child", [
      { id: "att_1", absolutePath: srcFile, originalName: "screenshot.png", mime: "image/png", parentMessageId: "m_5" },
    ]);

    expect(existsSync(join(dir, "threads", "t_child", "attachments", "att_1.png"))).toBe(true);
    rmSync(srcDir, { recursive: true, force: true });
  });

  it("skips copying attachments that exceed the 25MB cap and records sentinel sha256", async () => {
    const srcDir = mkdtempSync(join(tmpdir(), "att-large-"));
    const srcFile = join(srcDir, "huge.bin");
    writeFileSync(srcFile, Buffer.from([0]));

    // Inject a custom statFn that reports the file as oversized without writing real bytes.
    const oversizedStatFn = async (_path: string) => ({ size: 26 * 1024 * 1024 });
    const storageWithOverride = HandoffStorage.forTesting({
      mcodeDirFn: () => dir,
      statFn: oversizedStatFn,
    });

    const manifest = await storageWithOverride.copyAttachments("t_child", [
      { id: "att_large", absolutePath: srcFile, originalName: "huge.bin", mime: "application/octet-stream", parentMessageId: "m_10" },
    ]);

    expect(manifest).toHaveLength(1);
    expect(manifest[0].sha256).toBe("<skipped>");
    expect(existsSync(join(dir, "threads", "t_child", "attachments", "att_large.bin"))).toBe(false);

    rmSync(srcDir, { recursive: true, force: true });
  });

  it("deleteThreadFiles removes the entire thread subtree", async () => {
    await storage.write("t_child", makeArtifact());
    await storage.deleteThreadFiles("t_child");
    expect(existsSync(join(dir, "threads", "t_child"))).toBe(false);
  });
});
