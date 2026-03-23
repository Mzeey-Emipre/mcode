import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openMemoryDatabase } from "../store/database.js";
import * as MessageRepo from "../repositories/message-repo.js";
import type Database from "better-sqlite3";

describe("message attachments", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openMemoryDatabase();
    // Create a workspace and thread for FK constraints
    db.exec(`
      INSERT INTO workspaces (id, name, path) VALUES ('ws-1', 'test', '/tmp/test');
      INSERT INTO threads (id, workspace_id, title, status, mode, branch, session_name)
        VALUES ('t-1', 'ws-1', 'test', 'active', 'direct', 'main', 'mcode-t-1');
    `);
  });

  afterEach(() => {
    db.close();
  });

  it("creates a message without attachments", () => {
    const msg = MessageRepo.create(db, "t-1", "user", "hello", 1);
    expect(msg.attachments).toBeNull();
  });

  it("creates a message with attachments", () => {
    const attachments = [
      { id: "att-1", name: "screenshot.png", mimeType: "image/png", sizeBytes: 1024 },
      { id: "att-2", name: "doc.pdf", mimeType: "application/pdf", sizeBytes: 2048 },
    ];
    const msg = MessageRepo.create(db, "t-1", "user", "check these", 1, attachments);

    expect(msg.attachments).toHaveLength(2);
    expect(msg.attachments![0].name).toBe("screenshot.png");
    expect(msg.attachments![1].mimeType).toBe("application/pdf");
  });

  it("round-trips attachments through listByThread", () => {
    const attachments = [
      { id: "att-1", name: "photo.jpg", mimeType: "image/jpeg", sizeBytes: 512 },
    ];
    MessageRepo.create(db, "t-1", "user", "look at this", 1, attachments);

    const messages = MessageRepo.listByThread(db, "t-1", 10);
    expect(messages).toHaveLength(1);
    expect(messages[0].attachments).toHaveLength(1);
    expect(messages[0].attachments![0].id).toBe("att-1");
  });

  it("stores empty attachments as null in DB and returns null from listByThread", () => {
    // create() returns the empty array as-is ([] ?? null === []), but the DB
    // stores null (empty arrays are serialised as null). listByThread therefore
    // deserialises as null.
    MessageRepo.create(db, "t-1", "user", "no files", 1, []);

    const messages = MessageRepo.listByThread(db, "t-1", 10);
    expect(messages[0].attachments).toBeNull();
  });

  it("handles the V3 migration column existence", () => {
    // V3 migration already ran in openMemoryDatabase, verify the column exists
    const info = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
    const hasAttachments = info.some((col) => col.name === "attachments");
    expect(hasAttachments).toBe(true);
  });
});
