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

/** Candidate-specific timing summary for one bounded comparison run. */
export interface RendererTimingSummary {
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly p99Ms: number | null;
  readonly maxMs: number | null;
}

/** Candidate-specific facts retained by the throwaway comparison route. */
export interface RendererRunMetrics {
  readonly parseRender: RendererTimingSummary;
  readonly paintBoundary: RendererTimingSummary;
  readonly throughputBytesPerSecond: number | null;
  readonly resizeToStablePaintMs: number | null;
  readonly switchRestoreMs: number | null;
  readonly markerCoverage: number;
  readonly droppedFrames: number;
  readonly lostInputEvents: number;
  readonly longFrameCount: number;
  readonly failures: readonly string[];
}

/** A single frame input shared by both renderer candidates. */
export interface RendererInputFrame {
  readonly seq: number;
  readonly bytes: number;
  readonly digest: string;
}

/** Capability status surfaced as a matrix rather than inferred from speed. */
export type RendererCapabilityStatus = "pass" | "fail" | "not-measured";

/** One row in the renderer capability matrix. */
export interface RendererCapabilityRow {
  readonly capability: string;
  readonly xterm: RendererCapabilityStatus;
  readonly ghostty: RendererCapabilityStatus;
  readonly note: string;
}

/** Explicit interactive and platform capability questions for this prototype. */
export const RENDERER_CAPABILITY_MATRIX: readonly RendererCapabilityRow[] = Object.freeze([
  { capability: "IME / dead keys", xterm: "pass", ghostty: "fail", note: "xterm owns a native input textarea; Canvas lacks production IME/dead-key composition." },
  { capability: "Mouse protocol", xterm: "pass", ghostty: "fail", note: "Ghostty has no production mouse-reporting or Canvas hit-test path." },
  { capability: "Selection / clipboard", xterm: "pass", ghostty: "fail", note: "Ghostty exposes an explicit text projection copy action only, not native selection parity." },
  { capability: "Accessible text projection", xterm: "pass", ghostty: "pass", note: "Both candidates expose terminal text for assistive technology." },
  { capability: "Unicode / CJK / combining", xterm: "pass", ghostty: "pass", note: "Covered by the jagged-reflow corpus workload." },
  { capability: "Alternate screen / fullscreen", xterm: "not-measured", ghostty: "not-measured", note: "No bounded corpus workload currently asserts alternate-screen state." },
  { capability: "Links", xterm: "not-measured", ghostty: "not-measured", note: "Link provider behavior is outside this parser-only comparison." },
  { capability: "Truecolor / SGR", xterm: "pass", ghostty: "pass", note: "ANSI color output is exercised by shaky-live-resizing." },
  { capability: "Bracketed paste", xterm: "not-measured", ghostty: "not-measured", note: "Requires an explicit paste event fixture and user gesture." },
  { capability: "Memory", xterm: "not-measured", ghostty: "not-measured", note: "Browser heap isolation was not credible in this route." },
]);

/** Return a percentile using nearest-rank interpolation over bounded samples. */
export function rendererPercentile(samples: readonly number[], percentile: number): number | null {
  if (samples.length === 0) return null;
  const ordered = [...samples].sort((left, right) => left - right);
  const rank = Math.min(ordered.length - 1, Math.max(0, Math.ceil(percentile * ordered.length) - 1));
  return ordered[rank] ?? null;
}

/** Summarize bounded timing samples for the report and raw JSON export. */
export function summarizeRendererTimings(samples: readonly number[]): RendererTimingSummary {
  return {
    p50Ms: rendererPercentile(samples, 0.5),
    p95Ms: rendererPercentile(samples, 0.95),
    p99Ms: rendererPercentile(samples, 0.99),
    maxMs: samples.length === 0 ? null : Math.max(...samples),
  };
}

/** Compare the exact frame sequence, byte lengths, and digests dispatched to two candidates. */
export function compareRendererInputFrames(
  left: readonly RendererInputFrame[],
  right: readonly RendererInputFrame[],
): boolean {
  return left.length === right.length && left.every((frame, index) => {
    const other = right[index];
    return other?.seq === frame.seq && other.bytes === frame.bytes && other.digest === frame.digest;
  });
}

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
