#!/usr/bin/env node
/**
 * Verify all repo prerequisites before starting work.
 * Prints ✓/✗ per check with actionable remediation on failure.
 * Exits 1 if any check fails.
 */
import { existsSync, mkdirSync, accessSync, constants, readdirSync } from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const require = createRequire(import.meta.url);

/**
 * Resolve the main checkout root, handling git worktrees where node_modules
 * live in the main checkout rather than the linked worktree directory.
 */
function resolveMainRoot() {
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: root, encoding: 'utf8',
    }).trim();
    return resolve(root, commonDir, '..');
  } catch {
    return root;
  }
}

const mainRoot = resolveMainRoot();

/**
 * Resolve the path to the better-sqlite3 module, checking both the root and
 * apps/server locations since Bun workspaces may not hoist it to the root.
 */
function resolveSqliteModule() {
  const candidates = [
    resolve(mainRoot, 'node_modules/better-sqlite3'),
    resolve(mainRoot, 'apps/server/node_modules/better-sqlite3'),
  ];
  return candidates.find(p => existsSync(p)) ?? null;
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
  execSync(`${locator} ${cmd}`, { stdio: 'pipe' });
}

console.log('Checking prerequisites...\n');

// 1-3. Required binaries
check('bun in PATH',  () => hasCommand('bun'),  'Install from https://bun.sh');
check('git in PATH',  () => hasCommand('git'),  'Install from https://git-scm.com');
check('node in PATH', () => hasCommand('node'), 'Install from https://nodejs.org');

// 4. Playwright
check(
  'Playwright available in apps/web',
  () => {
    const bin    = resolve(root, 'apps/web/node_modules/.bin/playwright');
    const binWin = resolve(root, 'apps/web/node_modules/.bin/playwright.cmd');
    if (!existsSync(bin) && !existsSync(binWin)) throw new Error();
  },
  'cd apps/web && bun x playwright install'
);

// 5. better-sqlite3 Node binding
check(
  'better-sqlite3 Node binding loads',
  () => {
    const modulePath = resolveSqliteModule();
    if (!modulePath) throw new Error('not found');
    require(modulePath);
  },
  'bun install'
);

// 6. Electron-ABI binding
check(
  'Electron-ABI better-sqlite3 binding exists',
  () => {
    const modulePath = resolveSqliteModule();
    if (!modulePath) throw new Error('not found');
    const prebuilds = resolve(modulePath, 'prebuilds');
    if (!existsSync(prebuilds)) throw new Error();
    const hasElectron = readdirSync(prebuilds).some(e => e.toLowerCase().includes('electron'));
    if (!hasElectron) throw new Error();
  },
  'node scripts/postinstall.mjs  (or: SKIP_ELECTRON_REBUILD=1 bun install)'
);

// 7. MCODE_DATA_DIR writable
const dataDir = process.env.MCODE_DATA_DIR
  ?? join(homedir(), process.env.NODE_ENV === 'production' ? '.mcode' : '.mcode-dev');
check(
  `MCODE_DATA_DIR writable (${dataDir})`,
  () => {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    accessSync(dataDir, constants.W_OK);
  },
  `Check permissions on ${dataDir}`
);

// 8. git hooks path
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
