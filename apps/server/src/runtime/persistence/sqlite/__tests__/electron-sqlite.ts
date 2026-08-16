import Database from "better-sqlite3";
import { resolveElectronNativeBinding } from "../database.js";

/** Opens an in-memory SQLite database with the Electron-native binding. */
export function openElectronMemoryDatabase(): Database.Database {
  return new Database(":memory:", { nativeBinding: resolveElectronNativeBinding() });
}
