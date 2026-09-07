import { Database } from "bun:sqlite";

/** Opens an in-memory database through Bun's SQLite implementation. */
export function openBunMemoryDatabase(): Database {
  return new Database(":memory:", { strict: true });
}
