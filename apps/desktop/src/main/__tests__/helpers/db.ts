import { openMemoryDatabase } from "../../store/database.js";
import type Database from "better-sqlite3";

export function createTestDb(): Database.Database {
  return openMemoryDatabase();
}
