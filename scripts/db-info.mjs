/**
 * Print SQLite database location, schema version, and basic table stats.
 * Opens the database read-only; safe to run while the server is running.
 */
import * as NodeChildProcess from 'node:child_process';
import * as NodeFS from 'node:fs';
import * as NodePath from 'node:path';
import * as NodeURL from 'node:url';
import { resolveMainRoot } from './utils.mjs';

if (!process.versions.electron) {
  const { resolveCliDbPath } = await import('./resolve-cli-db-path.mjs');
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    ['scripts/run-electron-node.mjs', NodeURL.fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    {
      cwd: resolveMainRoot(),
      env: { ...process.env, MCODE_DB_PATH: resolveCliDbPath() },
      stdio: 'inherit',
    },
  );
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

const dbPath = process.env.MCODE_DB_PATH;
if (!dbPath) {
  throw new Error('MCODE_DB_PATH is required when db-info runs under Electron Node.');
}
const root = resolveMainRoot();
const bindingPath = process.env.BETTER_SQLITE3_BINDING;
if (!bindingPath) {
  throw new Error('BETTER_SQLITE3_BINDING is required when db-info runs under Electron Node.');
}
if (!NodePath.isAbsolute(bindingPath) || !NodeFS.existsSync(bindingPath) || !NodeFS.statSync(bindingPath).isFile()) {
  throw new Error(`BETTER_SQLITE3_BINDING must reference an existing absolute file: ${bindingPath}`);
}

console.log(`Database : ${dbPath}`);

if (!NodeFS.existsSync(dbPath)) {
  console.log('Status   : not found (start the server to create it)');
  process.exit(0);
}

try {
  const { createRequire } = await import('node:module');
  const serverRequire = createRequire(`${root}/apps/server/package.json`);
  const Database = serverRequire('better-sqlite3');
  const db = new Database(dbPath, {
    readonly: true,
    nativeBinding: bindingPath,
  });

  const vRow = db.prepare('SELECT version FROM _migrations ORDER BY version DESC LIMIT 1').get();
  console.log(`Schema   : v${vRow ? vRow.version : 0}`);

  for (const table of ['workspaces', 'threads', 'messages']) {
    const { count } = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
    console.log(`${table.padEnd(10)}: ${count} rows`);
  }

  db.close();
} catch (err) {
  console.error(`Error    : ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
