/** Payload delivered to a registered PTY data listener. */
export interface PtyDataPayload {
  readonly ptyId: string;
  readonly payload: Uint8Array;
  readonly seq: number;
}

/** Payload delivered to a registered PTY exit listener. */
export interface PtyExitPayload {
  readonly ptyId: string;
  readonly code: number;
}

/** Payload delivered on a reconnect gap. */
export interface PtyReconnectGapPayload {
  readonly ptyId: string;
}

type PtyDataCallback = (detail: PtyDataPayload) => void;
type PtyExitCallback = (detail: PtyExitPayload) => void;
type PtyReconnectGapCallback = (detail: PtyReconnectGapPayload) => void;

/**
 * Callback registry for PTY events. Replaces window CustomEvent
 * dispatch with O(1) Map lookups, avoiding event object allocation and
 * the browser's full event dispatch machinery on every PTY data chunk.
 */
const dataListeners = new Map<string, PtyDataCallback>();
const exitListeners = new Map<string, Set<PtyExitCallback>>();
const reconnectGapListeners = new Map<string, PtyReconnectGapCallback>();

/**
 * Register a data listener for a specific PTY. Returns an unsubscribe function.
 * Only one listener per PTY is allowed — a duplicate registration warns and
 * overwrites the previous listener to avoid silent data loss.
 */
export function onPtyData(ptyId: string, cb: PtyDataCallback): () => void {
  if (import.meta.env.DEV && dataListeners.has(ptyId)) {
    console.warn(`[ptyDataRegistry] overwriting existing data listener for PTY ${ptyId}`);
  }
  dataListeners.set(ptyId, cb);
  return () => { dataListeners.delete(ptyId); };
}

/**
 * Register an exit listener for a specific PTY. Returns an unsubscribe function.
 * Terminal lifecycle consumers may observe the same exit independently.
 */
export function onPtyExit(ptyId: string, cb: PtyExitCallback): () => void {
  const listeners = exitListeners.get(ptyId) ?? new Set<PtyExitCallback>();
  listeners.add(cb);
  exitListeners.set(ptyId, listeners);
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) exitListeners.delete(ptyId);
  };
}

/**
 * Register a reconnect-gap listener for a specific PTY. Returns an unsubscribe function.
 * Only one listener per PTY is allowed.
 */
export function onPtyReconnectGap(ptyId: string, cb: PtyReconnectGapCallback): () => void {
  if (import.meta.env.DEV && reconnectGapListeners.has(ptyId)) {
    console.warn(`[ptyDataRegistry] overwriting existing reconnect-gap listener for PTY ${ptyId}`);
  }
  reconnectGapListeners.set(ptyId, cb);
  return () => { reconnectGapListeners.delete(ptyId); };
}

/** Dispatch a data event to the registered listener for the given PTY. */
export function emitPtyData(detail: PtyDataPayload): void {
  dataListeners.get(detail.ptyId)?.(detail);
}

/** Dispatch an exit event to the registered listener for the given PTY. */
export function emitPtyExit(detail: PtyExitPayload): void {
  for (const listener of exitListeners.get(detail.ptyId) ?? []) listener(detail);
}

/** Dispatch a reconnect-gap event to the registered listener for the given PTY. */
export function emitPtyReconnectGap(detail: PtyReconnectGapPayload): void {
  reconnectGapListeners.get(detail.ptyId)?.(detail);
}
