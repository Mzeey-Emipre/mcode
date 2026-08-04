/** Candidate identifiers used by the renderer head-to-head prototype. */
export const TERMINAL_RENDERER_CANDIDATES = ["xterm", "ghostty"] as const;

/** A renderer candidate identifier. */
export type TerminalRendererCandidate =
  (typeof TERMINAL_RENDERER_CANDIDATES)[number];

/** Stable workload identifiers shared with the native terminal corpus. */
export const TERMINAL_RENDERER_WORKLOAD_IDS = [
  "wrong-width-restoration",
  "jagged-reflow",
  "shaky-live-resizing",
  "bottom-row-clipping",
  "high-output-pressure",
  "reconnect-recovery",
  "interactive-program",
  "process-cleanup",
] as const;

/** A workload identifier from {@link TERMINAL_RENDERER_WORKLOAD_IDS}. */
export type TerminalRendererWorkloadId =
  (typeof TERMINAL_RENDERER_WORKLOAD_IDS)[number];

/** Safety limits applied to every renderer comparison run. */
export const TERMINAL_RENDERER_WORKLOAD_LIMITS = Object.freeze({
  maxCols: 140,
  maxRows: 40,
  maxResizeCount: 12,
  minResizeIntervalMs: 10,
  maxOutputBytes: 128 * 1024,
  maxDurationMs: 2_000,
  maxReplayBytes: 32 * 1024,
  maxProcessLifetimeMs: 3_000,
});

/** Viewport facts needed to preserve a user’s position through a resize. */
export interface RendererViewportAnchor {
  /** Number of rows between the viewport tail and the buffer tail. */
  readonly linesFromBottom: number;
  /** Whether the viewport was already following the terminal tail. */
  readonly followingTail: boolean;
}

/** A resize request that can be coalesced to the newest complete grid. */
export interface RendererResizeRequest {
  readonly cols: number;
  readonly rows: number;
  readonly requestedAt: number;
}

/** Return the newest resize request while enforcing the corpus bounds. */
export function coalesceRendererResize(
  requests: readonly RendererResizeRequest[],
): RendererResizeRequest | null {
  const latest = requests.at(-1);
  if (!latest) return null;
  const cols = Math.max(1, Math.min(TERMINAL_RENDERER_WORKLOAD_LIMITS.maxCols, Math.round(latest.cols)));
  const rows = Math.max(1, Math.min(TERMINAL_RENDERER_WORKLOAD_LIMITS.maxRows, Math.round(latest.rows)));
  return { cols, rows, requestedAt: latest.requestedAt };
}

/** Restore a viewport anchor after a terminal has changed dimensions. */
export function restoreRendererViewportAnchor(
  anchor: RendererViewportAnchor,
  bufferLength: number,
  rows: number,
): number {
  const maxViewportY = Math.max(0, bufferLength - rows);
  if (anchor.followingTail) return maxViewportY;
  return Math.max(
    0,
    Math.min(maxViewportY, bufferLength - Math.max(0, anchor.linesFromBottom) - rows),
  );
}

/** Return the fraction of expected workload markers found in a candidate view. */
export function markerCoverage(
  text: string,
  expectedMarkers: readonly string[],
): number {
  if (expectedMarkers.length === 0) return 1;
  const found = expectedMarkers.reduce(
    (count, marker) => count + (text.includes(marker) ? 1 : 0),
    0,
  );
  return found / expectedMarkers.length;
}

