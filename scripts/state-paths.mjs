#!/usr/bin/env node
/**
 * Print resolved runtime artifact paths for the current environment.
 * Useful for debugging where mcode stores its state.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';

const dataDir = process.env.MCODE_DATA_DIR
  ?? join(homedir(), process.env.NODE_ENV === 'production' ? '.mcode' : '.mcode-dev');
const dbPath  = process.env.MCODE_DB_PATH ?? join(dataDir, 'mcode.db');
const logDir  = join(dataDir, 'logs');

console.log(`Data dir : ${dataDir}`);
console.log(`Database : ${dbPath}`);
console.log(`Logs     : ${logDir}`);
