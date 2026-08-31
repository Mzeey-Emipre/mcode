#!/usr/bin/env bun
/**
 * Shared utilities for Mcode root scripts.
 */
import * as NodeChildProcess from 'node:child_process';
import * as NodePath from 'node:path';
import * as NodeURL from 'node:url';

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

/** Absolute path to the monorepo root (parent of `scripts/`). */
export const scriptRoot = NodePath.resolve(__dirname, '..');

/**
 * Resolve the main checkout root, handling git worktrees where node_modules
 * live in the main checkout rather than the linked worktree directory.
 * @returns {string} Absolute path to the main checkout root.
 */
export function resolveMainRoot() {
  try {
    const commonDir = NodeChildProcess.execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: scriptRoot, encoding: 'utf8',
    }).trim();
    return NodePath.resolve(scriptRoot, commonDir, '..');
  } catch {
    return scriptRoot;
  }
}
