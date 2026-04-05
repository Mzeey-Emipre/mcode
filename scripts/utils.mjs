#!/usr/bin/env node
/**
 * Shared utilities for Mcode root scripts.
 */
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the monorepo root (parent of `scripts/`). */
export const scriptRoot = resolve(__dirname, '..');

/**
 * Resolve the main checkout root, handling git worktrees where node_modules
 * live in the main checkout rather than the linked worktree directory.
 * @returns {string} Absolute path to the main checkout root.
 */
export function resolveMainRoot() {
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: scriptRoot, encoding: 'utf8',
    }).trim();
    return resolve(scriptRoot, commonDir, '..');
  } catch {
    return scriptRoot;
  }
}
