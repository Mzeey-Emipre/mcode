import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it } from "vitest";
import { openDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { TurnSnapshotRepo } from "../persistence/turn-snapshot-repo.js";

const MIGRATIONS_THROUGH_0056 = "0056_red_cable";

function copyMigrationsThrough(
  sourceDirectory: string,
  destinationDirectory: string,
  lastTag: string,
): void {
  const journalPath = NodePath.join(sourceDirectory, "meta", "_journal.json");
  const journal = JSON.parse(NodeFS.readFileSync(journalPath, "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  const cutoff = journal.entries.findIndex((entry) => entry.tag === lastTag);
  if (cutoff === -1) throw new Error(`Missing migration journal entry: ${lastTag}`);

  const entries = journal.entries.slice(0, cutoff + 1);
  NodeFS.mkdirSync(NodePath.join(destinationDirectory, "meta"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(destinationDirectory, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries }),
  );
  for (const entry of entries) {
    NodeFS.copyFileSync(
      NodePath.join(sourceDirectory, `${entry.tag}.sql`),
      NodePath.join(destinationDirectory, `${entry.tag}.sql`),
    );
  }
}

it("upgrades an existing nightly database without rewriting assistant history or Git snapshots", () => {
  const scratch = NodePath.resolve(process.cwd(), "../../.codex/tmp");
  NodeFS.mkdirSync(scratch, { recursive: true });
  const directory = NodeFS.mkdtempSync(NodePath.join(scratch, "turn-diff-upgrade-"));
  if (NodePath.dirname(directory) !== scratch) throw new Error("Fixture outside scratch root");
  const dbPath = NodePath.join(directory, "history.sqlite");
  const currentMigrationsDirectory = NodePath.join(process.cwd(), "drizzle");
  const previousMigrationsDirectory = NodePath.join(directory, "drizzle-through-0056");
  const originalMigrationsDirectory = process.env.MCODE_DRIZZLE_MIGRATIONS_DIR;
  copyMigrationsThrough(
    currentMigrationsDirectory,
    previousMigrationsDirectory,
    MIGRATIONS_THROUGH_0056,
  );

  process.env.MCODE_DRIZZLE_MIGRATIONS_DIR = previousMigrationsDirectory;
  let db = openDatabase({ dbPath });
  try {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("ws-1", "Test", directory, now, now);
    db.prepare("INSERT INTO threads (id, workspace_id, title, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("thread-1", "ws-1", "Existing nightly", "main", now, now);
    db.prepare("INSERT INTO messages (id, thread_id, role, content, timestamp, sequence) VALUES (?, ?, ?, ?, ?, ?)").run("message-1", "thread-1", "assistant", "Existing answer", now, 1);
    const snapshot = new TurnSnapshotRepo(db).create({ messageId: "message-1", threadId: "thread-1", refBefore: "before", refAfter: "after", filesChanged: ["a.txt"], worktreePath: null });
    db.close(true);

    process.env.MCODE_DRIZZLE_MIGRATIONS_DIR = currentMigrationsDirectory;
    db = openDatabase({ dbPath });
    expect(db.prepare("SELECT content, sequence FROM messages WHERE id = ?").get("message-1")).toEqual({ content: "Existing answer", sequence: 1 });
    expect(new TurnSnapshotRepo(db).getById(snapshot.id)).toEqual(snapshot);
    expect(db.prepare("SELECT count(*) AS count FROM turn_diff_snapshots").get()).toEqual({ count: 0 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close(true);
    if (originalMigrationsDirectory === undefined) delete process.env.MCODE_DRIZZLE_MIGRATIONS_DIR;
    else process.env.MCODE_DRIZZLE_MIGRATIONS_DIR = originalMigrationsDirectory;
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
