#!/usr/bin/env bun
/**
 * CLI entry point for managing SQLite migrations.
 *
 * Usage:
 *   bun run db:migrate status        - Show applied and pending migrations
 *   bun run db:migrate up [n]        - Apply all (or next n) pending migrations
 *   bun run db:migrate down [n]      - Roll back last 1 (or n) migrations
 *   bun run db:migrate new <name>    - Scaffold a new migration file
 */

import Database from "better-sqlite3";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, readdirSync, writeFileSync } from "fs";
import { getMcodeDir } from "@mcode/shared";
import { MigrationRunner } from "../migrations/runner.js";
import { loadMigrations } from "../database.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const migrationsDir = join(__dirname, "..", "migrations");

const dbPath = process.env.MCODE_DB_PATH ?? join(getMcodeDir(), "mcode.db");

/** Pads a version number to 3 digits (e.g. 16 -> "016"). */
function pad(n: number): string {
  return String(n).padStart(3, "0");
}

/** Prints usage instructions and exits with the given code. */
function printUsage(exitCode = 0): never {
  console.log(`Usage:
  bun run db:migrate status          Show applied and pending migrations
  bun run db:migrate up [n]          Apply all (or next n) pending migrations
  bun run db:migrate down [n]        Roll back last 1 (or n) migrations
  bun run db:migrate new <name>      Scaffold a new migration file`);
  process.exit(exitCode);
}

/** Opens the database without running migrations (used by CLI to inspect state). */
function openDb(): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

const [, , command, ...args] = process.argv;

if (!command || command === "--help" || command === "-h") {
  printUsage(0);
}

switch (command) {
  case "status": {
    const db = openDb();
    const runner = new MigrationRunner(db, loadMigrations());
    const applied = runner.applied();
    const pending = runner.pending();

    if (applied.length === 0 && pending.length === 0) {
      console.log("No migrations found.");
    }

    for (const m of applied) {
      console.log(`✅ V${pad(m.version)} ${m.name}  (applied: ${m.appliedAt})`);
    }
    for (const m of pending) {
      console.log(`⏳ V${pad(m.version)} ${m.name}  [not yet applied]`);
    }
    break;
  }

  case "up": {
    const steps = args[0] !== undefined ? parseInt(args[0], 10) : undefined;
    if (steps !== undefined && (isNaN(steps) || steps <= 0)) {
      console.error("Error: n must be a positive integer");
      process.exit(1);
    }

    const db = openDb();
    const runner = new MigrationRunner(db, loadMigrations());
    const pending = runner.pending();

    if (pending.length === 0) {
      console.log("Already up to date.");
      break;
    }

    const toApply = steps !== undefined ? pending.slice(0, steps) : pending;
    console.log(`Applying ${toApply.length} pending migration${toApply.length === 1 ? "" : "s"}...`);

    try {
      const result = runner.up(steps);
      for (const m of result.migrations) {
        console.log(`✅ V${pad(m.version)} ${m.name}`);
      }
      console.log(`Done. ${result.applied} migration${result.applied === 1 ? "" : "s"} applied.`);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    break;
  }

  case "down": {
    const steps = args[0] !== undefined ? parseInt(args[0], 10) : 1;
    if (isNaN(steps) || steps <= 0) {
      console.error("Error: n must be a positive integer");
      process.exit(1);
    }

    const db = openDb();
    const runner = new MigrationRunner(db, loadMigrations());

    console.log(`Rolling back ${steps} migration${steps === 1 ? "" : "s"}...`);

    try {
      const result = runner.down(steps);
      if (result.reverted === 0) {
        console.log("Nothing to roll back.");
      } else {
        for (const m of result.migrations) {
          console.log(`↩️  V${pad(m.version)} ${m.name}`);
        }
        console.log(`Done. ${result.reverted} migration${result.reverted === 1 ? "" : "s"} reverted.`);
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    break;
  }

  case "new": {
    const name = args[0];
    if (!name) {
      console.error("Error: missing required argument <name>");
      process.exit(1);
    }

    // Find highest version number from existing migration filenames.
    const files = existsSync(migrationsDir)
      ? readdirSync(migrationsDir).filter((f) => /^\d+_/.test(f))
      : [];

    const highestVersion = files.reduce((max, f) => {
      const match = f.match(/^(\d+)_/);
      return match ? Math.max(max, parseInt(match[1], 10)) : max;
    }, 0);

    const nextVersion = highestVersion + 1;
    const slug = name.replace(/\s+/g, "_").toLowerCase();
    const filename = `${pad(nextVersion)}_${slug}.ts`;
    const outputPath = join(migrationsDir, filename);

    const scaffold = `import type Database from "better-sqlite3";

export const description = "${name}";

export function up(db: Database.Database): void {
  // TODO: implement migration
}

export function down(db: Database.Database): void {
  // TODO: implement rollback
}
`;

    writeFileSync(outputPath, scaffold);
    console.log(`Created: apps/server/src/store/migrations/${filename}`);
    break;
  }

  default:
    console.error(`Unknown command: ${command}`);
    printUsage(1);
}
