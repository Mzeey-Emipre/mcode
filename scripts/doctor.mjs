#!/usr/bin/env bun
/**
 * Verify all repo prerequisites before starting work.
 * Prints ✓/✗ per check with actionable remediation on failure.
 * Exits 1 if any check fails.
 */
import * as NodeFS from 'node:fs';
import * as NodeChildProcess from 'node:child_process';
import * as NodePath from 'node:path';
import * as NodeOS from 'node:os';
import { resolveMainRoot } from './utils.mjs';
import {
  isElectronBinaryInstalled,
  resolveElectronPackageDir,
} from './ensure-electron.mjs';

const mainRoot = resolveMainRoot();

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
  NodeChildProcess.execFileSync(locator, [cmd], { stdio: 'pipe' });
}

console.log('Checking prerequisites...\n');

// Repository scripts and the backend run under Bun.
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

check(
  'Bun SQLite runtime available',
  () => {
    if (!process.versions.bun) throw new Error('bun:sqlite requires Bun');
  },
  'bun install'
);

// 7. MCODE_DATA_DIR writable
const dataDir = process.env.MCODE_DATA_DIR
  ?? NodePath.join(NodeOS.homedir(), process.env.NODE_ENV === 'production' ? '.mcode' : '.mcode-dev');
check(
  `MCODE_DATA_DIR writable (${dataDir})`,
  () => {
    if (!NodeFS.existsSync(dataDir)) throw new Error('directory does not exist — start the app once to create it');
    NodeFS.accessSync(dataDir, NodeFS.constants.W_OK);
  },
  `Start the server once (bun run dev:web) or create manually: mkdir -p ${dataDir}`
);

// Summary
console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
