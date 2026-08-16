import { describe, it, expect } from "vitest";
import { FakeGitExecutor } from "../fake-git-executor.js";

describe("FakeGitExecutor", () => {
  it("records calls and returns canned responses", async () => {
    const fake = new FakeGitExecutor();
    fake.setResponse(["rev-parse", "--git-dir"], { stdout: ".git\n", stderr: "" });

    const result = await fake.exec(["-C", "/repo", "rev-parse", "--git-dir"]);

    expect(result.stdout).toBe(".git\n");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.args).toEqual(["-C", "/repo", "rev-parse", "--git-dir"]);
  });

  it("accepts concurrent calls for the same repo cwd", async () => {
    const fake = new FakeGitExecutor();
    fake.setResponse(["rev-parse", "--git-dir"], { stdout: ".git\n", stderr: "" });

    await Promise.all([
      fake.exec(["-C", "/repo", "rev-parse", "--git-dir"]),
      fake.exec(["-C", "/repo", "rev-parse", "--git-dir"]),
    ]);

    expect(fake.calls).toHaveLength(2);
    expect(fake.calls.every((c) => c.args.includes("--git-dir"))).toBe(true);
  });

  it("propagates registered errors", async () => {
    const fake = new FakeGitExecutor();
    fake.setResponse(["status", "--porcelain"], new Error("not a git repo"));

    await expect(fake.exec(["-C", "/repo", "status", "--porcelain"])).rejects.toThrow(
      "not a git repo",
    );
  });
});
