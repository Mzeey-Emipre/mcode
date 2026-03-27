/**
 * Push event broadcasting.
 * Sends push events to all connected WebSocket clients.
 */

import type { WebSocket } from "ws";
import { WS_CHANNELS, type WsChannelName } from "@mcode/contracts";
import { logger } from "@mcode/shared";

const clients = new Set<WebSocket>();

/** Register a WebSocket client for push event delivery. */
export function addClient(ws: WebSocket): void {
  clients.add(ws);
}

/** Remove a disconnected WebSocket client. */
export function removeClient(ws: WebSocket): void {
  clients.delete(ws);
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
