import { expect, test } from "bun:test";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  assertOwnedActiveRun,
  cleanupKnownEvidence,
  findFixtureWorkspace,
  readActiveRun,
  writeActiveRun,
} from "./thread-lifecycle.mjs";

const RUN_ID = "2026-09-01T15-30-12-745Z-41992074-e96c-4a1b-bc2d-074e96cc0000";
const CLI = NodePath.join(import.meta.dirname, "verify-mcode.mjs");

function withEvidenceDirectory(run) {
  const temporaryDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "verify-mcode-thread-lifecycle-"));
  const evidenceDirectory = NodePath.join(temporaryDirectory, ".dev", "verification", "thread-lifecycle");
  NodeFS.mkdirSync(evidenceDirectory, { recursive: true });
  try {
    return run(evidenceDirectory, temporaryDirectory);
  } finally {
    NodeFS.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function ownedRun(evidenceDirectory, temporaryDirectory) {
  const fixtureRepoPath = NodePath.join(temporaryDirectory, ".dev", "fixture-repo");
  const worktreePath = NodePath.join(fixtureRepoPath, "worktrees", "main-verify");
  const record = {
    desktopRuntimeDirectory: NodePath.join(temporaryDirectory, ".dev", "electron-thread-lifecycle", "runtime"),
    id: RUN_ID,
    runDirectory: NodePath.join(evidenceDirectory, "runs", RUN_ID),
    threadId: "thread-verify",
    workspaceId: "workspace-verify",
    worktreePath,
  };
  const workspace = { id: record.workspaceId, path: fixtureRepoPath };
  const thread = {
    id: record.threadId,
    mode: "worktree",
    title: `Complete worktree ${RUN_ID.slice(-8)}`,
    workspace_id: record.workspaceId,
    worktree_managed: true,
    worktree_path: record.worktreePath,
  };
  return { fixtureRepoPath, record, thread, workspace };
}

function supportsFileSymlinks() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "verify-mcode-symlink-"));
  const target = NodePath.join(directory, "target.json");
  const link = NodePath.join(directory, "link.json");
  try {
    NodeFS.writeFileSync(target, "{}");
    NodeFS.symlinkSync(target, link, "file");
    return NodeFS.lstatSync(link).isSymbolicLink();
  } catch {
    return false;
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
}

test("refuses cleanup records that point outside the verifier run directory", () => {
  withEvidenceDirectory((evidenceDirectory, temporaryDirectory) => {
    const { fixtureRepoPath, record, thread, workspace } = ownedRun(evidenceDirectory, temporaryDirectory);
    const tamperedRecord = { ...record, runDirectory: NodePath.join(temporaryDirectory, "outside") };

    expect(() => assertOwnedActiveRun(
      evidenceDirectory,
      fixtureRepoPath,
      { ...record, id: "not-a-run-id" },
      workspace,
      thread,
    )).toThrow("invalid run ID");
    expect(() => assertOwnedActiveRun(evidenceDirectory, fixtureRepoPath, tamperedRecord, workspace, thread))
      .toThrow("runDirectory is not the expected direct child");
  });
});

test("refuses cleanup records with a foreign workspace or generated-thread mismatch", () => {
  withEvidenceDirectory((evidenceDirectory, temporaryDirectory) => {
    const { fixtureRepoPath, record, thread, workspace } = ownedRun(evidenceDirectory, temporaryDirectory);

    expect(() => assertOwnedActiveRun(
      evidenceDirectory,
      fixtureRepoPath,
      record,
      { ...workspace, id: "workspace-other" },
      thread,
    )).toThrow("fixture workspace");
    expect(() => assertOwnedActiveRun(
      evidenceDirectory,
      fixtureRepoPath,
      record,
      workspace,
      { ...thread, worktree_path: NodePath.join(temporaryDirectory, "other-worktree") },
    )).toThrow("generated managed-worktree thread");
    expect(() => assertOwnedActiveRun(
      evidenceDirectory,
      fixtureRepoPath,
      record,
      workspace,
      { ...thread, title: "Complete another worktree" },
    )).toThrow("generated managed-worktree thread");
  });
});

const caseSensitivePathTest = process.platform === "win32" ? test.skip : test;

caseSensitivePathTest("finds uppercase fixture paths on case-sensitive platforms", async () => {
  const fixtureRepoPath = NodePath.join(NodeOS.tmpdir(), "FixtureRepoUPPER");
  const workspace = { id: "workspace-verify", path: fixtureRepoPath };
  const socket = { rpc: async () => [workspace] };

  await expect(findFixtureWorkspace(socket, fixtureRepoPath)).resolves.toBe(workspace);
});

test("refuses non-regular active-run files before reading or writing", () => {
  withEvidenceDirectory((evidenceDirectory, temporaryDirectory) => {
    const { record } = ownedRun(evidenceDirectory, temporaryDirectory);
    NodeFS.mkdirSync(NodePath.join(evidenceDirectory, "active-run.json"));

    expect(() => readActiveRun(evidenceDirectory)).toThrow("not a regular file");
    expect(() => writeActiveRun(evidenceDirectory, record)).toThrow("not a regular file");
  });
});

const symlinkTest = supportsFileSymlinks() ? test : test.skip;

symlinkTest("refuses active-run symlinks before reading or writing", () => {
  withEvidenceDirectory((evidenceDirectory, temporaryDirectory) => {
    const { record } = ownedRun(evidenceDirectory, temporaryDirectory);
    const target = NodePath.join(temporaryDirectory, "active-run-target.json");
    const activeRun = NodePath.join(evidenceDirectory, "active-run.json");
    NodeFS.writeFileSync(target, JSON.stringify(record));
    NodeFS.symlinkSync(target, activeRun, "file");

    expect(() => readActiveRun(evidenceDirectory)).toThrow("symbolic link");
    expect(() => writeActiveRun(evidenceDirectory, record)).toThrow("symbolic link");
    expect(NodeFS.readFileSync(target, "utf8")).toBe(JSON.stringify(record));
  });
});

test("removes known evidence while preserving unexpected files", () => {
  withEvidenceDirectory((evidenceDirectory) => {
    const receiptsDirectory = NodePath.join(evidenceDirectory, "receipts");
    const runsDirectory = NodePath.join(evidenceDirectory, "runs");
    NodeFS.mkdirSync(receiptsDirectory, { recursive: true });
    NodeFS.mkdirSync(runsDirectory, { recursive: true });
    const ownedReceipt = NodePath.join(receiptsDirectory, `${RUN_ID}-receipt.json`);
    const ownedLog = NodePath.join(evidenceDirectory, "2026-09-01T15-30-12-745Z-thread-lifecycle-server.log");
    const ownedRun = NodePath.join(runsDirectory, RUN_ID);
    const unexpectedReceipt = NodePath.join(receiptsDirectory, "notes.json");
    const unexpectedFile = NodePath.join(evidenceDirectory, "keep.txt");
    const unexpectedRun = NodePath.join(runsDirectory, "manual-investigation");
    for (const path of [ownedReceipt, ownedLog, unexpectedReceipt, unexpectedFile]) {
      NodeFS.writeFileSync(path, "evidence");
    }
    NodeFS.mkdirSync(unexpectedRun);
    NodeFS.mkdirSync(ownedRun);

    const result = cleanupKnownEvidence(evidenceDirectory);

    expect(NodeFS.existsSync(ownedReceipt)).toBe(false);
    expect(NodeFS.existsSync(ownedLog)).toBe(false);
    expect(NodeFS.existsSync(ownedRun)).toBe(false);
    expect(NodeFS.existsSync(unexpectedReceipt)).toBe(true);
    expect(NodeFS.existsSync(unexpectedFile)).toBe(true);
    expect(NodeFS.existsSync(unexpectedRun)).toBe(true);
    expect(result.evidenceDirectoryRemoved).toBe(false);
  });
});

async function runCli(args) {
  const child = Bun.spawn([process.execPath, CLI, ...args], { stdout: "pipe", stderr: "pipe" });
  return {
    code: await child.exited,
    stderr: await new Response(child.stderr).text(),
    stdout: await new Response(child.stdout).text(),
  };
}

test("shows selected-text desktop help through the public CLI", async () => {
  const result = await runCli(["desktop", "selected-text-comments", "--help"]);

  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("desktop selected-text-comments <setup|proof|cleanup>");
});

test("returns bounded actionable JSON for malformed lifecycle commands", async () => {
  const result = await runCli(["thread-lifecycle", "not-a-command"]);
  const output = JSON.parse(result.stdout);

  expect(result.code).toBe(1);
  expect(result.stderr).toBe("");
  expect(output).toMatchObject({ ok: false, command: "not-a-command" });
  expect(output.failure).toContain("Condition: Unknown command: not-a-command.");
  expect(output.failure).toContain("Next action:");
  expect(output.failure.length).toBeLessThanOrEqual(640);
});
