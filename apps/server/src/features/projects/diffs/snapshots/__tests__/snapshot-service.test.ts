import "reflect-metadata";
import { describe, it, expect, beforeEach } from "vitest";
import { FakeGitExecutor } from "../../../git/execution/fake-git-executor.js";
import type { GitExecutor } from "../../../git/execution/types.js";
import { SnapshotService } from "../snapshot-service.js";

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
      ["-C", cwd, "status", "--porcelain"],
    ]);
  });

  it("falls back to staged capture when the tree becomes dirty before the second status check", async () => {
    const stagedSha = "staged-tree-sha";
    let statusCalls = 0;
    const toctouFake: GitExecutor = {
      async exec(args) {
        const normalized = args[0] === "-C" ? args.slice(2) : args;
        if (normalized[0] === "status") {
          statusCalls += 1;
          return { stdout: statusCalls <= 1 ? "" : " M file.txt\n", stderr: "" };
        }
        if (normalized.join(" ") === "rev-parse HEAD^{tree}") {
          return { stdout: `${treeSha}\n`, stderr: "" };
        }
        if (normalized.join(" ") === "rev-parse --git-dir") {
          return { stdout: `${gitDir}\n`, stderr: "" };
        }
        if (normalized[0] === "read-tree") return { stdout: "", stderr: "" };
        if (normalized[0] === "add") return { stdout: "", stderr: "" };
        if (normalized[0] === "write-tree") return { stdout: `${stagedSha}\n`, stderr: "" };
        return { stdout: "", stderr: "" };
      },
    };

    const result = await new SnapshotService(toctouFake).captureRef(cwd);

    expect(result).toBe(stagedSha);
    expect(statusCalls).toBe(2);
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

describe("SnapshotService.validateRef", () => {
  let fake: FakeGitExecutor;
  let service: SnapshotService;
  const cwd = "/repo";

  beforeEach(() => {
    fake = new FakeGitExecutor();
    service = new SnapshotService(fake);
  });

  it("rejects refs that look like git flags", async () => {
    expect(await service.validateRef(cwd, "--batch")).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("SnapshotService ref and numstat validation", () => {
  it("rejects flag-shaped refs before invoking Git", async () => {
    const fake = new FakeGitExecutor();
    const service = new SnapshotService(fake);

    await expect(service.getFileAtRef("/repo", "--batch", "file.txt")).resolves.toEqual({
      kind: "missing",
    });
    await expect(service.getFilesChanged("/repo", "--output=x", "after")).resolves.toEqual([]);
    await expect(service.getDiff("/repo", "--output=x", "after")).resolves.toBe("");
    await expect(service.getDiffStats("/repo", "before", "--output=x")).resolves.toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });

  it("returns destination paths for simple and brace-form numstat renames", async () => {
    const executor: GitExecutor = {
      async exec() {
        return {
          stdout: "0\t0\told.txt => new.txt\n1\t2\tarch/{i386 => x86}/Makefile\n",
          stderr: "",
        };
      },
    };
    const service = new SnapshotService(executor);

    await expect(service.getDiffStats("/repo", "before", "after")).resolves.toEqual([
      { filePath: "new.txt", additions: 0, deletions: 0 },
      { filePath: "arch/x86/Makefile", additions: 1, deletions: 2 },
    ]);
  });
});

describe("SnapshotService attributed path batching", () => {
  it("includes paths beyond the first 512 without exceeding per-call bounds", async () => {
    const calls: string[][] = [];
    const executor: GitExecutor = {
      async exec(args) {
        calls.push([...args]);
        const lastPathspec = args.at(-1) ?? "";
        return { stdout: `diff for ${lastPathspec}\n`, stderr: "" };
      },
    };
    const service = new SnapshotService(executor);
    const paths = Array.from({ length: 600 }, (_, index) => `src/file-${index}.ts`);

    const diff = await service.getDiff("/repo", "before", "after", undefined, undefined, paths);

    expect(calls).toHaveLength(5);
    expect(calls.every((args) => args.filter((arg) => arg.startsWith(":(literal)")).length <= 128)).toBe(true);
    expect(calls.flat()).toContain(":(literal)src/file-599.ts");
    expect(diff).toContain(":(literal)src/file-599.ts");
  });

  it("keeps rename pairs together when a batch boundary is reached", async () => {
    const calls: string[][] = [];
    const executor: GitExecutor = {
      async exec(args) {
        calls.push([...args]);
        return { stdout: "", stderr: "" };
      },
    };
    const service = new SnapshotService(executor);
    const singles = Array.from({ length: 127 }, (_, index) => [`src/file-${index}.ts`]);
    const renamePair = ["src/new-name.ts", "src/old-name.ts"];
    const groups = [...singles, renamePair];

    await service.getDiff(
      "/repo",
      "before",
      "after",
      undefined,
      undefined,
      groups.flat(),
      groups,
    );

    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain(":(literal)src/new-name.ts");
    expect(calls[1]).toContain(":(literal)src/old-name.ts");
  });
});
