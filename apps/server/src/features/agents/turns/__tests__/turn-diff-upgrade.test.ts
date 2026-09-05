import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it } from "vitest";
import { openDatabase } from "../../../../runtime/persistence/sqlite/database.js";
import { TurnSnapshotRepo } from "../persistence/turn-snapshot-repo.js";

it("upgrades an existing nightly database without rewriting assistant history or Git snapshots", () => {
  const scratch = NodePath.resolve(process.cwd(), "../../.codex/tmp");
  NodeFS.mkdirSync(scratch, { recursive: true });
  const directory = NodeFS.mkdtempSync(NodePath.join(scratch, "turn-diff-upgrade-"));
  if (NodePath.dirname(directory) !== scratch) throw new Error("Fixture outside scratch root");
  const dbPath = NodePath.join(directory, "history.sqlite");
  let db = openDatabase({ dbPath });
  try {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("ws-1", "Test", directory, now, now);
    db.prepare("INSERT INTO threads (id, workspace_id, title, branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("thread-1", "ws-1", "Existing nightly", "main", now, now);
    db.prepare("INSERT INTO messages (id, thread_id, role, content, timestamp, sequence) VALUES (?, ?, ?, ?, ?, ?)").run("message-1", "thread-1", "assistant", "Existing answer", now, 1);
    const snapshot = new TurnSnapshotRepo(db).create({ messageId: "message-1", threadId: "thread-1", refBefore: "before", refAfter: "after", filesChanged: ["a.txt"], worktreePath: null });
    db.exec("DROP TABLE turn_diff_snapshots; DELETE FROM __drizzle_migrations WHERE created_at = (SELECT MAX(created_at) FROM __drizzle_migrations)");
    db.close();
    db = openDatabase({ dbPath });
    expect(db.prepare("SELECT content, sequence FROM messages WHERE id = ?").get("message-1")).toEqual({ content: "Existing answer", sequence: 1 });
    expect(new TurnSnapshotRepo(db).getById(snapshot.id)).toEqual(snapshot);
    expect(db.prepare("SELECT count(*) AS count FROM turn_diff_snapshots").get()).toEqual({ count: 0 });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  } finally {
    if (db.open) db.close();
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
