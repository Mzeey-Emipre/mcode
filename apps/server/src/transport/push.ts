/**
 * Push event broadcasting.
 * Sends push events to all connected WebSocket clients.
 */

import type { WebSocket } from "ws";
import { WS_CHANNELS, type WsChannelName } from "@mcode/contracts";
import { logger } from "@mcode/shared";

const clients = new Set<WebSocket>();

let _sessionCount = 0;
const sessionChangeListeners: ((count: number) => void)[] = [];

/**
 * Get the net cumulative session count.
 *
 * Each `addClient` call increments this value; each `removeClient` call
 * decrements it. This tracks session lifecycle (total connects minus
 * total disconnects) and is distinct from `clientCount()`, which returns
 * `clients.size` - the number of sockets currently open.
 */
export function sessionCount(): number {
  return _sessionCount;
}

/**
 * Register a callback invoked whenever the session count changes.
 * Returns an unsubscribe function that removes the callback.
 */
export function onSessionChange(cb: (count: number) => void): () => void {
  sessionChangeListeners.push(cb);
  return () => {
    const idx = sessionChangeListeners.indexOf(cb);
    if (idx >= 0) sessionChangeListeners.splice(idx, 1);
  };
}

/** Register a WebSocket client for push event delivery. */
export function addClient(ws: WebSocket): void {
  clients.add(ws);
  _sessionCount++;
  for (const cb of [...sessionChangeListeners]) cb(_sessionCount);
}

/** Remove a disconnected WebSocket client. No-op if already removed. */
export function removeClient(ws: WebSocket): void {
  if (!clients.delete(ws)) return;
  _sessionCount--;
  for (const cb of [...sessionChangeListeners]) cb(_sessionCount);
}

/** Get the current number of connected clients. */
export function clientCount(): number {
  return clients.size;
}

/**
 * Broadcast a push event to all connected WebSocket clients.
 * Validates the data against the channel's Zod schema before sending.
 */
export function broadcast(
  channel: WsChannelName,
  data: unknown,
): void {
  const schema = WS_CHANNELS[channel];
  if (!schema) {
    logger.warn("Unknown push channel", { channel });
    return;
  }

  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    logger.warn("Push data validation failed", {
      channel,
      error: parsed.error.message,
    });
    return;
  }

  const payload = JSON.stringify({
    type: "push" as const,
    channel,
    data: parsed.data,
  });

  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(payload);
    }
  }
}

/**
 * Reset module-level state to a clean baseline.
 *
 * FOR TESTING ONLY. Do not call this in production code.
 * Resets `_sessionCount` to 0, clears `sessionChangeListeners`, and
 * empties the `clients` set so each test starts from a known state.
 */
export function _resetForTest(): void {
  _sessionCount = 0;
  sessionChangeListeners.length = 0;
  clients.clear();
}
