/**
 * IPC push relay - connects a Node.js net.Socket to the server's IPC pipe
 * and forwards length-prefixed frames to the renderer via webContents.send.
 *
 * The main process owns the socket because the preload runs in a sandbox
 * that does not have access to the Node.js `net` module.
 */

import { connect as netConnect } from "net";

/** Maximum permitted frame body size (8 MiB). Frames larger than this indicate
 *  a corrupt or malicious length prefix; the socket is destroyed immediately. */
const MAX_FRAME_SIZE = 8 * 1024 * 1024;

/** Minimal subset of BrowserWindow required by the relay. */
interface RelayWindow {
  isDestroyed(): boolean;
  webContents: {
    isDestroyed(): boolean;
    send(channel: string, ...args: unknown[]): void;
  };
}

/**
 * Connect to the server's IPC push endpoint and forward parsed frames
 * to the renderer via `webContents.send("ipc-push-message", data)`.
 *
 * Wire format: each frame is a 4-byte big-endian length prefix followed by
 * the UTF-8 encoded JSON body.
 *
 * @returns A cleanup function. Call it when the window closes to destroy
 *   the socket and prevent a named-pipe handle leak on Windows.
 */
export function startIpcRelay(ipcPath: string, window: RelayWindow): () => void {
  if (!ipcPath) return () => { /* no-op: no socket was opened */ };

  const socket = netConnect(ipcPath);
  const chunks: Buffer[] = [];
  let totalLen = 0;

  socket.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
    totalLen += chunk.length;

    // Avoid concat overhead when only one chunk is buffered.
    let buffer = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, totalLen);
    chunks.length = 0;
    totalLen = 0;

    while (buffer.length >= 4) {
      const frameLen = buffer.readUInt32BE(0);
      if (frameLen > MAX_FRAME_SIZE) {
        socket.destroy();
        return;
      }
      if (buffer.length < 4 + frameLen) break;

      const json = buffer.subarray(4, 4 + frameLen).toString("utf-8");
      buffer = buffer.subarray(4 + frameLen);

      try {
        const data = JSON.parse(json) as unknown;
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
          window.webContents.send("ipc-push-message", data);
        }
      } catch { /* malformed frame - skip */ }
    }

    // Retain leftover bytes for the next data event.
    if (buffer.length > 0) {
      chunks.push(buffer);
      totalLen = buffer.length;
    }
  });

  socket.on("error", () => socket.destroy());
  socket.on("close", () => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send("ipc-push-disconnect");
    }
  });

  return () => socket.destroy();
}
