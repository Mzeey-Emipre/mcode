import "reflect-metadata";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { SnapshotService } from "../services/snapshot-service";

/**
 * Integration tests for SnapshotService using real git repositories.
 * These tests exercise the full git pipeline with no mocks to verify
 * actual behavior against the filesystem.
 */

/** Initializes a fresh git repo in a temp directory with one committed file. */
function createGitRepo(): string {
  const tmpDir = mkdtempSync(join(tmpdir(), "mcode-snap-test-"));

  execFileSync("git", ["-C", tmpDir, "init", "-b", "main"]);
  execFileSync("git", ["-C", tmpDir, "config", "user.email", "test@mcode.test"]);
  execFileSync("git", ["-C", tmpDir, "config", "user.name", "Mcode Test"]);

  // Create an initial file and commit so HEAD exists
  writeFileSync(join(tmpDir, "existing.txt"), "line one\nline two\nline three\n");
  execFileSync("git", ["-C", tmpDir, "add", "existing.txt"]);
  execFileSync("git", ["-C", tmpDir, "commit", "-m", "initial commit"]);

  return tmpDir;
}

/** Initializes a fresh git repo with no commits (unborn HEAD). */
function createUnbornRepo(): string {
  const tmpDir = mkdtempSync(join(tmpdir(), "mcode-snap-unborn-"));

  execFileSync("git", ["-C", tmpDir, "init", "-b", "main"]);
  execFileSync("git", ["-C", tmpDir, "config", "user.email", "test@mcode.test"]);
  execFileSync("git", ["-C", tmpDir, "config", "user.name", "Mcode Test"]);

  return tmpDir;
}

describe("SnapshotService integration", () => {
  let service: SnapshotService;
  let tmpDir: string;

  beforeEach(() => {
    service = new SnapshotService();
    tmpDir = createGitRepo();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("new untracked files appear in getFilesChanged", async () => {
    const refBefore = await service.captureRef(tmpDir);

    writeFileSync(join(tmpDir, "newfile.ts"), 'export const x = 1;\n');

    const refAfter = await service.captureRef(tmpDir);

    expect(refBefore).not.toBe(refAfter);

    const files = await service.getFilesChanged(tmpDir, refBefore, refAfter);
    expect(files).toContain("newfile.ts");
  });

  it("modified tracked files appear in getFilesChanged", async () => {
    const refBefore = await service.captureRef(tmpDir);

    writeFileSync(join(tmpDir, "existing.txt"), "line one\nline two\nline three\nline four\n");

    const refAfter = await service.captureRef(tmpDir);

    expect(refBefore).not.toBe(refAfter);

    const files = await service.getFilesChanged(tmpDir, refBefore, refAfter);
    expect(files).toContain("existing.txt");
  });

  it("both new and modified files appear in getFilesChanged", async () => {
    const refBefore = await service.captureRef(tmpDir);

    writeFileSync(join(tmpDir, "existing.txt"), "line one\nline two\nline three\nmodified\n");
    writeFileSync(join(tmpDir, "brand-new.ts"), "export const brand = 'new';\n");

    const refAfter = await service.captureRef(tmpDir);

    expect(refBefore).not.toBe(refAfter);

    const files = await service.getFilesChanged(tmpDir, refBefore, refAfter);
    expect(files).toContain("existing.txt");
    expect(files).toContain("brand-new.ts");
  });

  it("clean tree returns the same ref for consecutive captureRef calls", async () => {
    // No changes between the two captures
    const refA = await service.captureRef(tmpDir);
    const refB = await service.captureRef(tmpDir);

    expect(refA).toBe(refB);

    const files = await service.getFilesChanged(tmpDir, refA, refB);
    expect(files).toHaveLength(0);
  });

  it("getDiff includes new file content", async () => {
    const refBefore = await service.captureRef(tmpDir);

    writeFileSync(join(tmpDir, "hello.ts"), "export function hello() {\n  return 'world';\n}\n");

    const refAfter = await service.captureRef(tmpDir);

    const diff = await service.getDiff(tmpDir, refBefore, refAfter);

    expect(diff).toContain("hello.ts");
    // Added lines are prefixed with '+' in unified diff
    expect(diff).toContain("+export function hello()");
  });

  it("getDiffStats counts new file additions", async () => {
    const newFileContent = "line 1\nline 2\nline 3\n";
    const expectedLineCount = newFileContent.split("\n").filter(Boolean).length; // 3

    const refBefore = await service.captureRef(tmpDir);

    writeFileSync(join(tmpDir, "counted.txt"), newFileContent);

    const refAfter = await service.captureRef(tmpDir);

    const stats = await service.getDiffStats(tmpDir, refBefore, refAfter);

    const fileStat = stats.find((s) => s.filePath === "counted.txt");
    expect(fileStat).toBeDefined();
    expect(fileStat!.additions).toBe(expectedLineCount);
    expect(fileStat!.deletions).toBe(0);
  });

  it("gitignored files are excluded from getFilesChanged", async () => {
    const refBefore = await service.captureRef(tmpDir);

    writeFileSync(join(tmpDir, ".gitignore"), "*.log\n");
    writeFileSync(join(tmpDir, "debug.log"), "some debug output\n");
    writeFileSync(join(tmpDir, "visible.txt"), "this file should appear\n");

    const refAfter = await service.captureRef(tmpDir);

    const files = await service.getFilesChanged(tmpDir, refBefore, refAfter);

    expect(files).not.toContain("debug.log");
    // The .gitignore itself and visible.txt are tracked changes
    expect(files).toContain(".gitignore");
    expect(files).toContain("visible.txt");
  });
});

describe("SnapshotService integration - unborn repo", () => {
  let service: SnapshotService;
  let tmpDir: string;

  beforeEach(() => {
    service = new SnapshotService();
    tmpDir = createUnbornRepo();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("captures files in a repo with no commits", async () => {
    writeFileSync(join(tmpDir, "first.ts"), "export const first = true;\n");

    const ref = await service.captureRef(tmpDir);

    // Should return a valid 40-char hex tree SHA, not empty
    expect(ref).toMatch(/^[0-9a-f]{40}$/);
    expect(ref).not.toBe("4b825dc642cb6eb9a060e54bf899d69f82cf7109"); // not the empty tree
  });

  it("detects new files between snapshots in unborn repo", async () => {
    const refBefore = await service.captureRef(tmpDir);

    writeFileSync(join(tmpDir, "hello.ts"), "export const hello = 'world';\n");

    const refAfter = await service.captureRef(tmpDir);

    expect(refBefore).not.toBe(refAfter);

    const files = await service.getFilesChanged(tmpDir, refBefore, refAfter);
    expect(files).toContain("hello.ts");
  });

  it("clean unborn repo returns the same (empty) tree SHA", async () => {
    const refA = await service.captureRef(tmpDir);
    const refB = await service.captureRef(tmpDir);

    expect(refA).toBe(refB);
    // Should be a valid 40-char hex tree SHA
    expect(refA).toMatch(/^[0-9a-f]{40}$/);
  });
});
