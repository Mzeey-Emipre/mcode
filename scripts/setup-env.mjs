#!/usr/bin/env bun
/**
 * Cross-platform setup script for bootstrapping a fresh clone.
 * Replaces scripts/setup-env.sh with Node.js so it works on Windows/PowerShell.
 */
import * as NodeFS from 'node:fs';
import * as NodePath from 'node:path';
import * as NodeURL from 'node:url';

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const root = NodePath.resolve(__dirname, '..');

/**
 * Run a setup step, printing a ✓/✗ status line.
 * Exits the process with code 1 if the step throws.
 * @param {string} label - Human-readable step description
 * @param {() => string | undefined} fn - Step implementation; return a short note to append to the ✓ line
 */
function step(label, fn) {
  try {
    const note = fn();
    console.log(`  ✓ ${label}${note ? ': ' + note : ''}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ ${label}: ${msg}`);
    process.exit(1);
  }
}

console.log('Setting up mcode...\n');

step('Create .env from .env.example', () => {
  const envPath = NodePath.resolve(root, '.env');
  const examplePath = NodePath.resolve(root, '.env.example');
  if (NodeFS.existsSync(envPath)) return 'already exists, skipped';
  NodeFS.copyFileSync(examplePath, envPath);
  return 'created';
});

console.log('\nSetup complete. Next steps:');
console.log('  bun install       # Install dependencies');
console.log('  bun run doctor    # Verify prerequisites');
console.log('  bun run dev:web   # Start web dev server');
