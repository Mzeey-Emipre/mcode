#!/usr/bin/env bun
/**
 * Verify all repo prerequisites before starting work.
 * Prints ✓/✗ per check with actionable remediation on failure.
 * Exits 1 if any check fails.
 */
import { existsSync, accessSync, constants, readFileSync } from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { resolveMainRoot, scriptRoot as root } from './utils.mjs';
import {
  isElectronBinaryInstalled,
  resolveElectronPackageDir,
} from './ensure-electron.mjs';

const mainRoot = resolveMainRoot();

/**
 * Resolve the path to the better-sqlite3 module, checking both the root and
 * apps/server locations since Bun workspaces may not hoist it to the root.
 */
function resolveSqliteModule() {
  try {
    const serverRequire = createRequire(resolve(mainRoot, 'apps', 'server', 'package.json'));
    return resolve(serverRequire.resolve('better-sqlite3/package.json'), '..');
  } catch {
    return null;
  }
}

let passed = 0;
let failed = 0;

/** Run a check, print result, and track pass/fail count. */
function check(label, fn, fix) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
    passed++;
  } catch {
    console.log(`  ✗ ${label}`);
    console.log(`    Fix: ${fix}`);
    failed++;
  }
}

/** Check whether a binary is available on PATH. */
function hasCommand(cmd) {
  const locator = process.platform === 'win32' ? 'where' : 'which';
  execFileSync(locator, [cmd], { stdio: 'pipe' });
}

console.log('Checking prerequisites...\n');

// Repository scripts run under Bun; backend and native modules run under Electron.
check('Bun runtime', () => {
  if (!process.versions.bun) throw new Error('doctor must run under Bun');
}, 'Run: bun run doctor');

// Required binaries
check('bun in PATH',  () => hasCommand('bun'),  'Install from https://bun.sh');
check('git in PATH',  () => hasCommand('git'),  'Install from https://git-scm.com');

// Electron binary (desktop dev and backend runtime)
check(
  'Electron binary installed',
  () => {
    if (!isElectronBinaryInstalled(resolveElectronPackageDir())) throw new Error();
  },
  'bun run install:electron'
);

// Electron-compatible better-sqlite3 binding
check(
  'better-sqlite3 Electron binding installed',
  () => {
    const modulePath = resolveSqliteModule();
    if (!modulePath) throw new Error('not found');
    const electronBinding = resolve(modulePath, 'build', 'Release', 'better_sqlite3.electron.node');
    if (!existsSync(electronBinding)) throw new Error();

    const markerPath = resolve(modulePath, 'build', 'Release', '.electron-abi');
    if (!existsSync(markerPath) || !/^\d+$/.test(readFileSync(markerPath, 'utf8').trim())) {
      throw new Error('Electron ABI marker is missing or invalid');
    }
  },
  'bun install'
);

// 7. MCODE_DATA_DIR writable
const dataDir = process.env.MCODE_DATA_DIR
  ?? join(homedir(), process.env.NODE_ENV === 'production' ? '.mcode' : '.mcode-dev');
check(
  `MCODE_DATA_DIR writable (${dataDir})`,
  () => {
    if (!existsSync(dataDir)) throw new Error('directory does not exist — start the app once to create it');
    accessSync(dataDir, constants.W_OK);
  },
  `Start the server once (bun run dev:web) or create manually: mkdir -p ${dataDir}`
);

// 9. git hooks path
check(
  'git hooks path configured (.githooks)',
  () => {
    const result = execSync('git config core.hooksPath', { cwd: root, stdio: 'pipe' })
      .toString()
      .trim();
    if (result !== '.githooks') throw new Error();
  },
  'bun run setup'
);

// Summary
console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
