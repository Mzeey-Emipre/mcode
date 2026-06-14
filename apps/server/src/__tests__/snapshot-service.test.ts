import "reflect-metadata";
import { describe, it, expect, beforeEach } from "vitest";
import { FakeGitExecutor } from "../services/git-executor/fake-git-executor.js";
import { SnapshotService } from "../services/snapshot-service.js";

describe("SnapshotService.captureRef", () => {
  let fake: FakeGitExecutor;
  let service: SnapshotService;
  const cwd = "/repo";
  const treeSha = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
  const gitDir = "/repo/.git";

  beforeEach(() => {
    fake = new FakeGitExecutor();
    service = new SnapshotService(fake);
  });

  it("returns HEAD tree SHA on a clean working tree without staging", async () => {
    fake.setResponse(["status", "--porcelain"], { stdout: "", stderr: "" });
    fake.setResponse(["rev-parse", "HEAD^{tree}"], { stdout: `${treeSha}\n`, stderr: "" });

    const result = await service.captureRef(cwd);

    expect(result).toBe(treeSha);
    expect(fake.calls.map((c) => c.args)).toEqual([
      ["-C", cwd, "status", "--porcelain"],
      ["-C", cwd, "rev-parse", "HEAD^{tree}"],
    ]);
  });

  it("returns the tree SHA from write-tree after read-tree + add -A when dirty", async () => {
    fake.setResponse(["status", "--porcelain"], { stdout: " M file.txt\n", stderr: "" });
    fake.setResponse(["rev-parse", "--git-dir"], { stdout: `${gitDir}\n`, stderr: "" });
    fake.setResponse(["read-tree", "HEAD"], { stdout: "", stderr: "" });
    fake.setResponse(["add", "-A"], { stdout: "", stderr: "" });
    fake.setResponse(["write-tree"], { stdout: `${treeSha}\n`, stderr: "" });

    const result = await service.captureRef(cwd);

    expect(result).toBe(treeSha);
    expect(fake.calls.some((c) => c.args.includes("add"))).toBe(true);
    expect(fake.calls.some((c) => c.args.includes("write-tree"))).toBe(true);
  });

  it("unborn repo: falls back to staged capture when HEAD^{tree} fails", async () => {
    fake.setResponse(["status", "--porcelain"], { stdout: "", stderr: "" });
    fake.setResponse(["rev-parse", "HEAD^{tree}"], new Error("fatal: Not a valid object name HEAD"));
    fake.setResponse(["rev-parse", "--git-dir"], { stdout: `${gitDir}\n`, stderr: "" });
    fake.setResponse(["read-tree", "HEAD"], new Error("fatal: Not a valid object name HEAD"));
    fake.setResponse(["add", "-A"], { stdout: "", stderr: "" });
    fake.setResponse(["write-tree"], { stdout: `${treeSha}\n`, stderr: "" });

    const result = await service.captureRef(cwd);

    expect(result).toBe(treeSha);
    expect(fake.calls.some((c) => c.args.includes("add"))).toBe(true);
  });

  it("throws when status fails on a non-git repo", async () => {
    fake.setResponse(["status", "--porcelain"], new Error("not a git repo"));

    await expect(service.captureRef(cwd)).rejects.toThrow("not a git repo");
  });

  it("throws when add -A fails on a dirty tree", async () => {
    fake.setResponse(["status", "--porcelain"], { stdout: " M file.txt\n", stderr: "" });
    fake.setResponse(["rev-parse", "--git-dir"], { stdout: `${gitDir}\n`, stderr: "" });
    fake.setResponse(["read-tree", "HEAD"], { stdout: "", stderr: "" });
    fake.setResponse(["add", "-A"], new Error("add failed"));

    await expect(service.captureRef(cwd)).rejects.toThrow("add failed");
  });
});
