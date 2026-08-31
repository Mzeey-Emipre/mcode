import * as NodeCrypto from "node:crypto";
import type Database from "better-sqlite3";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { bootstrapDrizzle } from "../bootstrap-drizzle.js";
import { openElectronMemoryDatabase } from "./electron-sqlite.js";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const DRIZZLE_DIR = NodePath.join(__dirname, "../../../../../drizzle");

const journal = JSON.parse(
  NodeFS.readFileSync(NodePath.join(DRIZZLE_DIR, "meta/_journal.json"), "utf-8"),
) as { entries: Array<{ tag: string; when: number }> };

const baselineTag = journal.entries[0]?.tag;
if (!baselineTag) throw new Error("missing baseline migration");

function baselineSqlHash(): string {
  const sqlContent = NodeFS.readFileSync(NodePath.join(DRIZZLE_DIR, `${baselineTag}.sql`), "utf-8");
  return NodeCrypto.createHash("sha256").update(sqlContent).digest("hex");
}

function freshDb(): Database.Database {
  const db = openElectronMemoryDatabase();
  db.pragma("foreign_keys = ON");
  return db;
}

/** Mimics legacy `_migrations` tracking rows without touching application DDL. */
function seedLegacyMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE _migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(
    `INSERT INTO _migrations (version, name) VALUES ('00000000000001', 'Initial schema')`,
  );
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
  return row !== undefined;
}

describe("bootstrapDrizzle", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDb();
  });

  afterEach(() => {
    db.close();
  });

  it("seeds __drizzle_migrations on legacy DB without creating application tables", () => {
    seedLegacyMigrations(db);
    db.exec("CREATE TABLE workspaces (id TEXT PRIMARY KEY)");

    bootstrapDrizzle(db, DRIZZLE_DIR);

    expect(tableExists(db, "__drizzle_migrations")).toBe(true);
    const rows = db.prepare("SELECT * FROM __drizzle_migrations").all() as Array<{
      hash: string;
      created_at: number;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].hash).toBe(baselineSqlHash());
    expect(rows[0].created_at).toBe(journal.entries[0].when);
  });

  it("is a no-op when __drizzle_migrations already exists", () => {
    db.exec(`
      CREATE TABLE __drizzle_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        hash text NOT NULL,
        created_at numeric
      )
    `);
    db
      .prepare(`INSERT INTO __drizzle_migrations ("hash", "created_at") VALUES (?, ?)`)
      .run("existing_hash", 1234567890);

    bootstrapDrizzle(db, DRIZZLE_DIR);

    const rows = db.prepare("SELECT * FROM __drizzle_migrations").all();
    expect(rows).toHaveLength(1);
  });

  it("does nothing on a fresh DB (no legacy tracker)", () => {
    bootstrapDrizzle(db, DRIZZLE_DIR);
    expect(tableExists(db, "__drizzle_migrations")).toBe(false);
  });

  it("recovers when __drizzle_migrations exists but is empty (interrupted bootstrap)", () => {
    seedLegacyMigrations(db);
    db.exec("CREATE TABLE workspaces (id TEXT PRIMARY KEY)");
    db.exec(`
      CREATE TABLE __drizzle_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        hash text NOT NULL,
        created_at numeric
      )
    `);

    bootstrapDrizzle(db, DRIZZLE_DIR);

    const rows = db.prepare("SELECT * FROM __drizzle_migrations").all() as Array<{
      hash: string;
      created_at: number;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].hash).toBe(baselineSqlHash());
    expect(rows[0].created_at).toBe(journal.entries[0].when);
  });

  it("does nothing when __drizzle_migrations is empty and no legacy tracker exists", () => {
    db.exec(`
      CREATE TABLE __drizzle_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        hash text NOT NULL,
        created_at numeric
      )
    `);

    bootstrapDrizzle(db, DRIZZLE_DIR);

    const rows = db.prepare("SELECT * FROM __drizzle_migrations").all();
    expect(rows).toHaveLength(0);
  });

  it("seeds when sentinel app table exists but no migration tracking (db:push DB)", () => {
    // No _migrations, no __drizzle_migrations: schema came from db:push or
    // a pre-legacy build. Sentinel `workspaces` proves the baseline ran.
    db.exec("CREATE TABLE workspaces (id TEXT PRIMARY KEY)");

    bootstrapDrizzle(db, DRIZZLE_DIR);

    const rows = db.prepare("SELECT * FROM __drizzle_migrations").all() as Array<{
      hash: string;
      created_at: number;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].hash).toBe(baselineSqlHash());
  });

  it("seeds when sentinel app table exists and __drizzle_migrations is empty", () => {
    db.exec("CREATE TABLE workspaces (id TEXT PRIMARY KEY)");
    db.exec(`
      CREATE TABLE __drizzle_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        hash text NOT NULL,
        created_at numeric
      )
    `);

    bootstrapDrizzle(db, DRIZZLE_DIR);

    const rows = db.prepare("SELECT * FROM __drizzle_migrations").all() as Array<{
      hash: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].hash).toBe(baselineSqlHash());
  });
});

describe("drizzle journal", () => {
  it("keeps branchless migration timestamps monotonic", () => {
    const byTag = new Map(journal.entries.map((entry) => [entry.tag, entry.when]));

    expect(byTag.get("0015_branchless_checkout_state")).toBeGreaterThan(
      byTag.get("0014_message_mentions")!,
    );
    expect(byTag.get("0016_branchless_base_branch")).toBeGreaterThan(
      byTag.get("0015_branchless_checkout_state")!,
    );
  });
});
