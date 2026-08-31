import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";

function parseMessage(line) {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function settleResponse(pending, message, formatError) {
  if (message.id == null || !pending.has(message.id)) return false;
  const { resolve, reject, method } = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) {
    reject(new Error(formatError(method, message.error)));
  } else {
    resolve(message.result);
  }
  return true;
}

/** Starts a Codex app-server JSON-RPC client for a standalone probe. */
export function startCodexAppServer({ cwd, onNotification, onStderr, onExit, formatError }) {
  const process = NodeChildProcess.spawn("codex", ["app-server"], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    shell: true,
    windowsHide: true,
  });
  const pending = new Map();
  let nextId = 1;

  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method });
      process.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  const output = NodeReadline.default.createInterface({ input: process.stdout });
  output.on("line", (line) => {
    const message = parseMessage(line);
    if (!message || settleResponse(pending, message, formatError)) return;
    onNotification(message);
  });
  if (onStderr) process.stderr.on("data", onStderr);
  if (onExit) process.on("exit", onExit);

  return {
    request,
    close(killAfterMs) {
      try {
        process.stdin.end();
      } catch {
        // The app-server can close stdin before the probe finishes.
      }
      setTimeout(() => process.kill(), killAfterMs);
    },
  };
}
