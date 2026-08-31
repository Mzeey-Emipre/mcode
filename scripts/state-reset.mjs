#!/usr/bin/env bun
/**
 * Safely reset MCODE_DATA_DIR (dev only).
 * Deletes and recreates the data directory. The app re-creates the database on next startup.
 */
import * as NodePath from 'node:path';
import * as NodeOS from 'node:os';
import * as NodeFS from 'node:fs';
import * as NodeReadline from 'node:readline';

if (process.env.NODE_ENV === 'production') {
  console.error('ERROR: state:reset refuses to run in production.');
  process.exit(1);
}

const dataDir = process.env.MCODE_DATA_DIR ?? NodePath.join(NodeOS.homedir(), '.mcode-dev');

// Guard: refuse to reset paths that don't look like mcode data directories
const resolvedHome = NodePath.resolve(NodeOS.homedir());
const resolvedDir  = NodePath.resolve(dataDir);
const rel = NodePath.relative(resolvedHome, resolvedDir);
if (rel.startsWith('..')) {
  console.error(`ERROR: Refusing to reset — ${dataDir} is outside the home directory.`);
  process.exit(1);
}
const segments = resolvedDir.replace(/\\/g, '/').split('/');
if (!segments.some(seg => seg === '.mcode' || seg.startsWith('.mcode-'))) {
  console.error(`ERROR: Refusing to reset — ${dataDir} does not look like a mcode data directory (expected segment ".mcode" or ".mcode-*").`);
  process.exit(1);
}

if (!NodeFS.existsSync(dataDir)) {
  console.log(`Nothing to reset — ${dataDir} does not exist.`);
  process.exit(0);
}

console.log('WARNING: This will delete all contents of:');
console.log(`  ${dataDir}`);
console.log('This includes the database, logs, and all app state.\n');

const rl = NodeReadline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Type "y" to confirm: ', answer => {
  rl.close();
  if (answer.trim().toLowerCase() !== 'y') {
    console.log('Aborted.');
    process.exit(0);
  }
  NodeFS.rmSync(dataDir, { recursive: true, force: true });
  NodeFS.mkdirSync(dataDir, { recursive: true });
  console.log(`\n✓ Reset complete. ${dataDir} is now empty.`);
  console.log('  The app will re-create the database on next startup.');
});
