#!/usr/bin/env bun
/**
 * Verify all repo prerequisites before starting work.
 * Prints ✓/✗ per check with actionable remediation on failure.
 * Exits 1 if any check fails.
 */
import { existsSync, accessSync, constants, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { resolveMainRoot } from './utils.mjs';
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

/** Returns the installed Electron module ABI. */
function getElectronABI() {
  const desktopRequire = createRequire(resolve(mainRoot, 'apps', 'desktop', 'package.json'));
  const electronBinary = desktopRequire('electron');
  const abi = execFileSync(
    electronBinary,
    ['-e', 'process.stdout.write(process.versions.modules)'],
    {
      cwd: mainRoot,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30_000,
    },
  ).trim();
  if (!/^\d+$/.test(abi)) throw new Error(`Electron reported invalid ABI: ${abi || 'empty'}`);
  return abi;
}

let passed = 0;
let failed = 0;

/** Run a check, print result, and track pass/fail count. */
function check(label, fn, fix) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
    passed++;
  } catch (error) {
    console.log(`  ✗ ${label}`);
    const reason = error instanceof Error ? error.message : String(error);
    if (reason) console.log(`    Reason: ${reason}`);
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
    if (!modulePath) throw new Error('better-sqlite3 module is not installed; run bun install');
    const electronBinding = resolve(modulePath, 'build', 'Release', 'better_sqlite3.electron.node');
    if (!existsSync(electronBinding)) {
      throw new Error(`better-sqlite3 Electron binding is missing: ${electronBinding}`);
    }

    const markerPath = resolve(modulePath, 'build', 'Release', '.electron-abi');
    if (!existsSync(markerPath)) throw new Error(`Electron ABI marker is missing: ${markerPath}`);
    const marker = readFileSync(markerPath, 'utf8').trim();
    const electronABI = getElectronABI();
    if (!/^\d+$/.test(marker) || marker !== electronABI) {
      throw new Error(
        `Electron ABI marker mismatch: expected ${electronABI}, found ${marker || 'missing'}`,
      );
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

// Summary
console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
