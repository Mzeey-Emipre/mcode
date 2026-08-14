import type { FitAddon } from "@xterm/addon-fit";

/**
 * Minimum terminal grid size before {@link FitAddon.fit} is safe.
 * xterm with very small cols (e.g. 2) re-wraps every line and evicts
 * fixed-size scrollback permanently.
 */
export const MIN_FIT_COLS = 10;

/** Maximum terminal columns accepted from the renderer fit proposal. */
export const MAX_FIT_COLS = 1_000;

/** Minimum rows before fit is safe (avoids 1-row grids during layout). */
export const MIN_FIT_ROWS = 3;

/** Maximum terminal rows accepted from the renderer fit proposal. */
export const MAX_FIT_ROWS = 500;

/** Minimum container width (px) before trusting proposeDimensions. */
const MIN_CONTAINER_WIDTH = 80;

/** Minimum container height (px) before trusting proposeDimensions. */
const MIN_CONTAINER_HEIGHT = 24;

/**
 * Returns true when proposed fit dimensions are large enough to avoid
 * scrollback-truncating re-wraps.
 */
export function isSafeTerminalDimensions(
  dims: { cols: number; rows: number } | undefined | null,
): dims is { cols: number; rows: number } {
  return (
    dims != null &&
    Number.isInteger(dims.cols) &&
    Number.isInteger(dims.rows) &&
    dims.cols >= MIN_FIT_COLS &&
    dims.cols <= MAX_FIT_COLS &&
    dims.rows >= MIN_FIT_ROWS &&
    dims.rows <= MAX_FIT_ROWS
  );
}

/**
 * Returns true when the xterm container has non-trivial layout size.
 */
export function isContainerReadyForFit(
  container: HTMLElement | null | undefined,
): boolean {
  return (
    container != null &&
    container.clientWidth >= MIN_CONTAINER_WIDTH &&
    container.clientHeight >= MIN_CONTAINER_HEIGHT
  );
}

/**
 * Runs {@link FitAddon.fit} only when the container is laid out, proposed
 * dimensions are safe, and the grid size would actually change. Skipping
 * no-op fits avoids xterm reflowing the buffer when the user returns to
 * a hidden terminal (thread switch).
 *
 * @param term When provided, fit is skipped if cols/rows already match.
 * @returns Whether fit() was called.
 */
export function safeFit(
  fitAddon: FitAddon,
  container: HTMLElement | null | undefined,
  term?: { cols: number; rows: number },
): boolean {
  if (!isContainerReadyForFit(container)) return false;
  const dims = fitAddon.proposeDimensions();
  if (!isSafeTerminalDimensions(dims)) return false;
  if (term && dims.cols === term.cols && dims.rows === term.rows) return false;
  fitAddon.fit();
  return true;
}
