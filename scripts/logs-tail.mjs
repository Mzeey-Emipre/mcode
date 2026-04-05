#!/usr/bin/env node
/**
 * Tail today's mcode log file. Streams existing content then follows for new lines.
 * Press Ctrl+C to exit.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createReadStream, watch, existsSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';

const dataDir = process.env.MCODE_DATA_DIR
  ?? join(homedir(), process.env.NODE_ENV === 'production' ? '.mcode' : '.mcode-dev');
const _d = new Date();
const today = `${_d.getFullYear()}-${String(_d.getMonth() + 1).padStart(2, '0')}-${String(_d.getDate()).padStart(2, '0')}`;
const logPath = join(dataDir, 'logs', `mcode.log.${today}`);

if (!existsSync(logPath)) {
  console.error(`No log file for today: ${logPath}`);
  console.error('Start the server first: bun run dev:web');
  process.exit(1);
}

console.error(`Tailing ${logPath}\n`);

// Stream existing content, then follow
let bytesRead = 0;

const rl = createInterface({ input: createReadStream(logPath) });
rl.on('line', line => process.stdout.write(line + '\n'));
rl.on('close', () => {
  bytesRead = statSync(logPath).size;
  watch(logPath, () => {
    const size = statSync(logPath).size;
    if (size <= bytesRead) return;
    const start = bytesRead;
    bytesRead = size; // advance immediately to prevent overlap if watch fires again
    const follow = createInterface({
      input: createReadStream(logPath, { start }),
    });
    follow.on('line', line => process.stdout.write(line + '\n'));
  });
});
