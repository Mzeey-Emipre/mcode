import "reflect-metadata";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { SnapshotService } from "../snapshot-service.js";
import { RealGitExecutor } from "../../../git/execution/real-git-executor.js";

const GIT_REPO_SETUP_TIMEOUT_MS = 30_000;
const GIT_OPERATION_TIMEOUT_MS = 30_000;

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
  const tree = execFileSync("git", ["-C", tmpDir, "write-tree"], { encoding: "utf8" }).trim();
  const commit = execFileSync("git", ["-C", tmpDir, "commit-tree", tree, "-m", "initial commit"], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Mcode Test",
      GIT_AUTHOR_EMAIL: "test@mcode.test",
      GIT_COMMITTER_NAME: "Mcode Test",
      GIT_COMMITTER_EMAIL: "test@mcode.test",
    },
  }).trim();
  execFileSync("git", ["-C", tmpDir, "update-ref", "refs/heads/main", commit]);

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
    service = new SnapshotService(new RealGitExecutor());
    tmpDir = createGitRepo();
  }, GIT_REPO_SETUP_TIMEOUT_MS);

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
  }, GIT_OPERATION_TIMEOUT_MS);

  it("modified tracked files appear in getFilesChanged", async () => {
    const refBefore = await service.captureRef(tmpDir);

    writeFileSync(join(tmpDir, "existing.txt"), "line one\nline two\nline three\nline four\n");

    const refAfter = await service.captureRef(tmpDir);

    expect(refBefore).not.toBe(refAfter);

    const files = await service.getFilesChanged(tmpDir, refBefore, refAfter);
    expect(files).toContain("existing.txt");
  }, GIT_OPERATION_TIMEOUT_MS);

  it("both new and modified files appear in getFilesChanged", async () => {
    const refBefore = await service.captureRef(tmpDir);

    writeFileSync(join(tmpDir, "existing.txt"), "line one\nline two\nline three\nmodified\n");
    writeFileSync(join(tmpDir, "brand-new.ts"), "export const brand = 'new';\n");

    const refAfter = await service.captureRef(tmpDir);

    expect(refBefore).not.toBe(refAfter);

    const files = await service.getFilesChanged(tmpDir, refBefore, refAfter);
    expect(files).toContain("existing.txt");
    expect(files).toContain("brand-new.ts");
  }, GIT_OPERATION_TIMEOUT_MS);

  it("clean tree returns the same ref for consecutive captureRef calls", async () => {
    // No changes between the two captures
    const refA = await service.captureRef(tmpDir);
    const refB = await service.captureRef(tmpDir);

    expect(refA).toBe(refB);

    const files = await service.getFilesChanged(tmpDir, refA, refB);
    expect(files).toHaveLength(0);
  }, GIT_OPERATION_TIMEOUT_MS);

  it("getDiff includes new file content", async () => {
    const refBefore = await service.captureRef(tmpDir);

    writeFileSync(join(tmpDir, "hello.ts"), "export function hello() {\n  return 'world';\n}\n");

    const refAfter = await service.captureRef(tmpDir);

    const diff = await service.getDiff(tmpDir, refBefore, refAfter);

    expect(diff).toContain("hello.ts");
    // Added lines are prefixed with '+' in unified diff
    expect(diff).toContain("+export function hello()");
  }, GIT_OPERATION_TIMEOUT_MS);

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
  }, GIT_OPERATION_TIMEOUT_MS);

  it("scopes historical diffs and stats to attributed paths", async () => {
    const refBefore = await service.captureRef(tmpDir);
    writeFileSync(join(tmpDir, "authored.txt"), "agent change\n");
    writeFileSync(join(tmpDir, "unrelated.txt"), "git pull change\n");
    const refAfter = await service.captureRef(tmpDir);

    const diff = await service.getDiff(
      tmpDir,
      refBefore,
      refAfter,
      undefined,
      undefined,
      ["authored.txt"],
    );
    const stats = await service.getDiffStats(tmpDir, refBefore, refAfter, ["authored.txt"]);

    expect(diff).toContain("authored.txt");
    expect(diff).not.toContain("unrelated.txt");
    expect(stats.map((entry) => entry.filePath)).toEqual(["authored.txt"]);
  }, GIT_OPERATION_TIMEOUT_MS);

  it("keeps both sides of a rename when opening the renamed file", async () => {
    const refBefore = await service.captureRef(tmpDir);
    renameSync(join(tmpDir, "existing.txt"), join(tmpDir, "renamed.txt"));
    const refAfter = await service.captureRef(tmpDir);

    const diff = await service.getDiff(
      tmpDir,
      refBefore,
      refAfter,
      "renamed.txt",
      undefined,
      ["renamed.txt", "existing.txt"],
      [["renamed.txt", "existing.txt"]],
    );

    expect(diff).toContain("similarity index 100%");
    expect(diff).toContain("rename from existing.txt");
    expect(diff).toContain("rename to renamed.txt");
  }, GIT_OPERATION_TIMEOUT_MS);

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
  }, GIT_OPERATION_TIMEOUT_MS);
});

describe("SnapshotService integration - unborn repo", () => {
  let service: SnapshotService;
  let tmpDir: string;

  beforeEach(() => {
    service = new SnapshotService(new RealGitExecutor());
    tmpDir = createUnbornRepo();
  }, GIT_OPERATION_TIMEOUT_MS);

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("captures files in a repo with no commits", async () => {
    writeFileSync(join(tmpDir, "first.ts"), "export const first = true;\n");

    const ref = await service.captureRef(tmpDir);

    // Should return a valid 40-char hex tree SHA, not empty
    expect(ref).toMatch(/^[0-9a-f]{40}$/);
    expect(ref).not.toBe("4b825dc642cb6eb9a060e54bf899d69f82cf7109"); // not the empty tree
  }, GIT_OPERATION_TIMEOUT_MS);

  it("detects new files between snapshots in unborn repo", async () => {
    const refBefore = await service.captureRef(tmpDir);

    writeFileSync(join(tmpDir, "hello.ts"), "export const hello = 'world';\n");

    const refAfter = await service.captureRef(tmpDir);

    expect(refBefore).not.toBe(refAfter);

    const files = await service.getFilesChanged(tmpDir, refBefore, refAfter);
    expect(files).toContain("hello.ts");
  }, GIT_OPERATION_TIMEOUT_MS);

  it("clean unborn repo returns the same (empty) tree SHA", async () => {
    const refA = await service.captureRef(tmpDir);
    const refB = await service.captureRef(tmpDir);

    expect(refA).toBe(refB);
    // Should be a valid 40-char hex tree SHA
    expect(refA).toMatch(/^[0-9a-f]{40}$/);
  }, GIT_OPERATION_TIMEOUT_MS);
});
