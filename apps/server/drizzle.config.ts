import { defineConfig } from "drizzle-kit";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** Default SQLite URL for CLI commands (`db:migrate`, `db:push`, …). Override with `MCODE_DRIZZLE_DB`. */
function defaultSqliteUrl(): string {
  const dirName =
    process.env.NODE_ENV === "production" ? ".mcode" : ".mcode-dev";
  const filePath = NodePath.join(NodeOS.homedir(), dirName, "mcode.db");
  return `file:${filePath.replace(/\\/g, "/")}`;
}

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/runtime/persistence/sqlite/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.MCODE_DRIZZLE_DB ?? defaultSqliteUrl(),
  },
});
