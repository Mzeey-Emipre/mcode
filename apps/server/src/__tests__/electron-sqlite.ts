import Database from "better-sqlite3";

/** Opens an in-memory SQLite database with the Electron-native binding. */
export function openElectronMemoryDatabase(): Database.Database {
  const nativeBinding = process.env.BETTER_SQLITE3_BINDING;
  if (!nativeBinding) {
    throw new Error("BETTER_SQLITE3_BINDING is required for Electron SQLite tests.");
  }
  return new Database(":memory:", { nativeBinding });
}
