/**
 * Push event broadcasting.
 * Sends push events to all connected WebSocket clients.
 */

import type { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { WS_CHANNELS, type WsChannelName, type SetThreadSubscriptionsInput, encodeTerminalDataFrame } from "@mcode/contracts";
import { logger } from "@mcode/shared";
import { getTransportPayloadValidator } from "./payload-validation.js";

/** Maximum transient agent events retained for one thread. */
export const MAX_AGENT_EVENT_JOURNAL_EVENTS_PER_THREAD = 256;
/** Maximum thread journals retained by the process. */
export const MAX_AGENT_EVENT_JOURNAL_THREADS = 100;

const clients = new Set<WebSocket>();
const threadSubscriptions = new Map<WebSocket, Set<string>>();
const threadJournals = new Map<string, { events: unknown[] }>();
const nextSequenceByThread = new Map<string, number>();
const eventEpoch = randomUUID();
const SUBSCRIPTION_SCOPED_CHANNELS = new Set<WsChannelName>([
  "agent.event",
  "agent.canonical",
  "turn.fileEffectsUpdated",
  "turn.savingStatus",
]);

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
  threadSubscriptions.set(ws, new Set());
  _sessionCount++;
  for (let i = 0; i < sessionChangeListeners.length; i++) sessionChangeListeners[i](_sessionCount);
}

/** Remove a disconnected WebSocket client. No-op if already removed. */
export function removeClient(ws: WebSocket): void {
  if (!clients.delete(ws)) return;
  threadSubscriptions.delete(ws);
  _sessionCount--;
  for (let i = 0; i < sessionChangeListeners.length; i++) sessionChangeListeners[i](_sessionCount);
}

/** Subscribe a connected client to push events for one thread. */
export function subscribeClientToThread(ws: WebSocket, threadId: string): void {
  if (!clients.has(ws)) return;
  const subscriptions = threadSubscriptions.get(ws) ?? new Set<string>();
  subscriptions.add(threadId);
  threadSubscriptions.set(ws, subscriptions);
}

/** Remove a connected client's push subscription for one thread. */
export function unsubscribeClientFromThread(ws: WebSocket, threadId: string): void {
  threadSubscriptions.get(ws)?.delete(threadId);
}

/** Atomically replace a connected client's complete desired subscription set. */
export function setClientThreadSubscriptions(
  ws: WebSocket,
  threadIds: readonly string[],
  cursors?: NonNullable<SetThreadSubscriptionsInput["cursors"]>,
): { hydrationRequiredThreadIds: string[]; replayedThrough: Record<string, number> } {
  if (!clients.has(ws)) return { hydrationRequiredThreadIds: [], replayedThrough: {} };
  threadSubscriptions.set(ws, new Set(threadIds));
  const hydrationRequiredThreadIds: string[] = [];
  const replayedThrough: Record<string, number> = {};
  if (!cursors) return { hydrationRequiredThreadIds, replayedThrough };

  for (const threadId of threadIds) {
    const rawCursor = cursors[threadId];
    if (rawCursor === undefined) continue;
    const cursor = typeof rawCursor === "number" ? rawCursor : rawCursor.sequence;
    if (typeof rawCursor !== "number" && rawCursor.epoch !== eventEpoch) {
      hydrationRequiredThreadIds.push(threadId);
      continue;
    }
    const journal = threadJournals.get(threadId);
    if (!journal) {
      if (cursor > 0) hydrationRequiredThreadIds.push(threadId);
      continue;
    }
    if (journal.events.length > 0 && cursor < (journal.events[0] as { sequence: number }).sequence - 1) {
      hydrationRequiredThreadIds.push(threadId);
      continue;
    }
    const pending = journal.events.filter((event) => (event as { sequence: number }).sequence > cursor);
    if (pending.length === 0) continue;
    let deliveredThrough = cursor;
    for (const event of pending) {
      if (!sendToClient(ws, "agent.event", event)) break;
      deliveredThrough = (event as { sequence: number }).sequence;
    }
    if (deliveredThrough !== cursor) replayedThrough[threadId] = deliveredThrough;
  }
  return { hydrationRequiredThreadIds, replayedThrough };
}

/** Get the current number of connected clients. */
export function clientCount(): number {
  return clients.size;
}

/**
 * Returns the maximum ws.bufferedAmount across all currently-open clients.
 * Used by the socket coordinator to drive server-side flow control.
 */
export function maxBufferedAmount(): number {
  let max = 0;
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) {
      if (ws.bufferedAmount > max) max = ws.bufferedAmount;
    }
  }
  return max;
}

function payloadThreadId(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const threadId = (data as { threadId?: unknown }).threadId;
  return typeof threadId === "string" && threadId.length > 0 ? threadId : undefined;
}

/**
 * Broadcast a push event to all connected WebSocket clients.
 * Validates the data against the channel's Zod schema before sending.
 */
export function broadcast(
  channel: WsChannelName,
  data: unknown,
): unknown {
  const schema = WS_CHANNELS[channel];
  if (!schema) {
    logger.warn("Unknown push channel", { channel });
    return undefined;
  }

  let candidate = data;
  const threadId = payloadThreadId(data);
  if (channel === "agent.event" && threadId && data && typeof data === "object") {
    const sequence = (nextSequenceByThread.get(threadId) ?? 0) + 1;
    candidate = { ...(data as Record<string, unknown>), sequence, epoch: eventEpoch };
  }

  const validation = getTransportPayloadValidator().validatePush(channel, candidate, schema);
  if (!validation.ok) {
    return undefined;
  }

  if (channel === "agent.event" && threadId) {
    const event = validation.data as { sequence: number };
    nextSequenceByThread.delete(threadId);
    nextSequenceByThread.set(threadId, event.sequence);
    const existing = threadJournals.get(threadId);
    const events = existing ? [...existing.events, validation.data] : [validation.data];
    if (events.length > MAX_AGENT_EVENT_JOURNAL_EVENTS_PER_THREAD) {
      events.splice(0, events.length - MAX_AGENT_EVENT_JOURNAL_EVENTS_PER_THREAD);
    }
    threadJournals.delete(threadId);
    threadJournals.set(threadId, { events });
    while (threadJournals.size > MAX_AGENT_EVENT_JOURNAL_THREADS) {
      const oldestThreadId = threadJournals.keys().next().value as string;
      threadJournals.delete(oldestThreadId);
    }
    while (nextSequenceByThread.size > MAX_AGENT_EVENT_JOURNAL_THREADS) {
      const oldestThreadId = nextSequenceByThread.keys().next().value as string;
      nextSequenceByThread.delete(oldestThreadId);
    }
  }

  const payload = JSON.stringify({
    type: "push" as const,
    channel,
    data: validation.data,
  });
  const requiresThreadSubscription = SUBSCRIPTION_SCOPED_CHANNELS.has(channel);

  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) {
      if (
        requiresThreadSubscription &&
        threadId &&
        !threadSubscriptions.get(ws)?.has(threadId)
      ) {
        continue;
      }
      ws.send(payload);
    }
  }
  return validation.data;
}

/** Sends one validated push event to exactly one connected WebSocket client. */
export function sendToClient(
  ws: WebSocket,
  channel: WsChannelName,
  data: unknown,
): boolean {
  if (!clients.has(ws) || ws.readyState !== ws.OPEN) return false;
  const schema = WS_CHANNELS[channel];
  if (!schema) return false;
  const validation = getTransportPayloadValidator().validatePush(channel, data, schema);
  if (!validation.ok) return false;
  try {
    ws.send(JSON.stringify({ type: "push" as const, channel, data: validation.data }));
    return true;
  } catch (error) {
    logger.warn("Directed push delivery failed", {
      channel,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Broadcast a PTY data chunk as a binary WebSocket frame.
 *
 * Uses the terminal-binary envelope so clients can decode ptyId + seq without
 * a preceding text header. Non-PTY channels continue to use JSON `broadcast`.
 */
export function broadcastTerminalData(
  ptyId: string,
  seq: number,
  payload: Uint8Array,
): void {
  const frame = encodeTerminalDataFrame(ptyId, seq, payload);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(frame, { binary: true });
      } catch (err) {
        // One bad socket must not interrupt delivery to the remaining clients.
        // Log and continue — the client will reconnect and re-request state.
        logger.warn("broadcastTerminalData: ws.send failed for a client", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
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
  threadSubscriptions.clear();
  threadJournals.clear();
  nextSequenceByThread.clear();
}
