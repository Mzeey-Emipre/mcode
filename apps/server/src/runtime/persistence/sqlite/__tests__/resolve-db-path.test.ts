import * as NodePath from "node:path";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import { describe, it, expect, afterEach } from "vitest";
import { resolveDbPath } from "@mcode/shared";

describe("resolveDbPath", () => {
  const originalEnv = process.env.NODE_ENV;
  const tmpDirs: string[] = [];

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    for (const dir of tmpDirs) {
      try { NodeFS.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
    }
    tmpDirs.length = 0;
  });

  function createTmpDir(prefix: string): string {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  }

  it("returns standard path when NODE_ENV is production", () => {
    process.env.NODE_ENV = "production";
    const base = NodePath.join("home", "user", ".mcode");
    const result = resolveDbPath(base);
    expect(result).toBe(NodePath.join(base, "mcode.db"));
  });

  it("returns standard path when no branch provided", () => {
    process.env.NODE_ENV = "development";
    const base = NodePath.join("home", "user", ".mcode-dev");
    const result = resolveDbPath(base);
    expect(result).toBe(NodePath.join(base, "mcode.db"));
  });

  it("uses .mcode-local under linked worktree root in dev", () => {
    process.env.NODE_ENV = "development";
    const root = createTmpDir("mcode-wt-");
    NodeFS.writeFileSync(NodePath.join(root, ".git"), "gitdir: /fake/main/.git/worktrees/wt\n", "utf-8");
    const base = NodePath.join("home", "user", ".mcode-dev");
    const result = resolveDbPath(base, { gitToplevel: root, branch: "feat/feature" });
    expect(result).toBe(NodePath.join(root, ".mcode-local", "mcode.db"));
  });

  it("uses branch hash for main repo (.git directory) even when gitToplevel set", () => {
    process.env.NODE_ENV = "development";
    const root = createTmpDir("mcode-main-");
    NodeFS.mkdirSync(NodePath.join(root, ".git"));
    const base = NodePath.join("home", "user", ".mcode-dev");
    const result = resolveDbPath(base, { gitToplevel: root, branch: "feat/other" });
    expect(NodePath.dirname(result)).toBe(NodePath.join(base, "dbs"));
    expect(NodePath.basename(result)).toMatch(/^dev-[a-f0-9]{12}\.db$/);
  });

  it("ignores linked worktree in production", () => {
    process.env.NODE_ENV = "production";
    const root = createTmpDir("mcode-wt-prod-");
    NodeFS.writeFileSync(NodePath.join(root, ".git"), "gitdir: /fake\n", "utf-8");
    const base = NodePath.join("home", "user", ".mcode");
    const result = resolveDbPath(base, { gitToplevel: root });
    expect(result).toBe(NodePath.join(base, "mcode.db"));
  });

  it("returns branch-specific path in non-production with branch", () => {
    process.env.NODE_ENV = "development";
    const base = NodePath.join("home", "user", ".mcode-dev");
    const result = resolveDbPath(base, { branch: "feat/my-feature" });
    expect(NodePath.dirname(result)).toBe(NodePath.join(base, "dbs"));
    expect(NodePath.basename(result)).toMatch(/^dev-[a-f0-9]{12}\.db$/);
  });

  it("produces different hashes for different branches", () => {
    process.env.NODE_ENV = "development";
    const base = NodePath.join("tmp", "mcode-db-branch-test");
    const a = resolveDbPath(base, { branch: "main" });
    const b = resolveDbPath(base, { branch: "feat/other" });
    expect(a).not.toBe(b);
  });

  it("produces the same hash for the same branch", () => {
    process.env.NODE_ENV = "development";
    const base = NodePath.join("tmp", "mcode-db-branch-test");
    const a = resolveDbPath(base, { branch: "main" });
    const b = resolveDbPath(base, { branch: "main" });
    expect(a).toBe(b);
  });

  it("falls back to standard path for empty branch string", () => {
    process.env.NODE_ENV = "development";
    const base = NodePath.join("tmp", "mcode-empty-branch");
    const result = resolveDbPath(base, { branch: "" });
    expect(result).toBe(NodePath.join(base, "mcode.db"));
  });
});
