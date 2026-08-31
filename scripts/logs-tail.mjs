#!/usr/bin/env bun
/**
 * Tail today's mcode log file. Streams existing content then follows for new lines.
 * Press Ctrl+C to exit.
 */
import * as NodePath from 'node:path';
import * as NodeOS from 'node:os';
import * as NodeFS from 'node:fs';
import * as NodeReadline from 'node:readline';

const dataDir = process.env.MCODE_DATA_DIR
  ?? NodePath.join(NodeOS.homedir(), process.env.NODE_ENV === 'production' ? '.mcode' : '.mcode-dev');
const _d = new Date();
const today = `${_d.getFullYear()}-${String(_d.getMonth() + 1).padStart(2, '0')}-${String(_d.getDate()).padStart(2, '0')}`;
const logPath = NodePath.join(dataDir, 'logs', `mcode.log.${today}`);

if (!NodeFS.existsSync(logPath)) {
  console.error(`No log file for today: ${logPath}`);
  console.error('Start the server first: bun run dev:web');
  process.exit(1);
}

console.error(`Tailing ${logPath}\n`);

// Stream existing content, then follow
let bytesRead = 0;

const rl = NodeReadline.createInterface({ input: NodeFS.createReadStream(logPath) });
rl.on('line', line => process.stdout.write(line + '\n'));
rl.on('close', () => {
  bytesRead = NodeFS.statSync(logPath).size;
  NodeFS.watch(logPath, () => {
    const size = NodeFS.statSync(logPath).size;
    if (size <= bytesRead) return;
    const start = bytesRead;
    bytesRead = size; // advance immediately to prevent overlap if watch fires again
    const follow = NodeReadline.createInterface({
      input: NodeFS.createReadStream(logPath, { start }),
    });
    follow.on('line', line => process.stdout.write(line + '\n'));
  });
});
