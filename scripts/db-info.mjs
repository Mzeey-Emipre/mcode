#!/usr/bin/env node
/**
 * Print SQLite database location, schema version, and basic table stats.
 * Opens the database read-only; safe to run while the server is running.
 */
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const worktreeRoot = resolve(__dirname, '..');
const require      = createRequire(import.meta.url);

// In a git worktree, node_modules live in the main checkout, not the worktree.
// Resolve the main checkout root from the git common dir (e.g. /path/to/repo/.git).
function resolveMainRoot() {
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: worktreeRoot, encoding: 'utf8',
    }).trim();
    // commonDir is either '.git' (main worktree) or an absolute path (linked worktree)
    const absCommon = resolve(worktreeRoot, commonDir);
    return dirname(absCommon); // parent of .git is the repo root
  } catch {
    return worktreeRoot;
  }
}

const root = resolveMainRoot();

const dataDir = process.env.MCODE_DATA_DIR
  ?? join(homedir(), process.env.NODE_ENV === 'production' ? '.mcode' : '.mcode-dev');
const dbPath  = process.env.MCODE_DB_PATH ?? join(dataDir, 'mcode.db');

console.log(`Database : ${dbPath}`);

if (!existsSync(dbPath)) {
  console.log('Status   : not found (start the server to create it)');
  process.exit(0);
}

try {
  // Bun workspaces may hoist better-sqlite3 to the root or keep it in apps/server.
  const modulePaths = [
    resolve(root, 'node_modules/better-sqlite3'),
    resolve(root, 'apps/server/node_modules/better-sqlite3'),
  ];
  const modulePath = modulePaths.find(p => existsSync(p));
  if (!modulePath) throw new Error('better-sqlite3 not found — run bun install first');
  const Database = require(modulePath);
  const db       = new Database(dbPath, { readonly: true });

  const vRow = db.prepare('SELECT version FROM _migrations ORDER BY version DESC LIMIT 1').get();
  console.log(`Schema   : v${vRow ? vRow.version : 0}`);

  for (const table of ['workspaces', 'threads', 'messages']) {
    const { count } = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
    console.log(`${table.padEnd(10)}: ${count} rows`);
  }

  db.close();
} catch (err) {
  console.error(`Error    : ${err.message}`);
  process.exit(1);
}
