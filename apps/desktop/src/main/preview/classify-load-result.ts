/**
 * Single source of truth for "did this preview load fail, and how". Pure: maps
 * the raw signals the host gets from a guest WebContents (HTTP status from
 * `did-navigate`, Chromium net error codes from `did-fail-load` /
 * `did-fail-provisional-load`) onto the shared {@link PreviewPageError} shape.
 *
 * The reducer and renderer never re-derive failure; they consume the result of
 * this function so error copy and detection stay in one place.
 */

import type { PreviewPageError } from "@mcode/contracts";

/** Chromium net error: the load was deliberately aborted (redirect, user cancel). */
const ERR_ABORTED = -3;
/** Chromium net error: a `file:` target did not exist on disk. */
const ERR_FILE_NOT_FOUND = -6;

/** Per-kind plain-language copy. The classifier is the only place these live. */
const COPY = {
  notFound: "Page not found",
  serverError: "The site had an error",
  httpOther: "The site returned an error",
  network: "Can't reach this site",
  fileMissing: "File no longer exists",
  crash: "This page crashed",
} as const;

/**
 * Classifies a load outcome.
 *
 * @param isMainFrame Whether the event came from the top-level frame. Sub-frame
 *   failures never blank the whole preview, so they always classify as `"ok"`.
 * @param errorCode Chromium net error code from a `did-fail-load` event, or `0`
 *   when the signal is an HTTP status (from `did-navigate`).
 * @param errorDescription Chromium's net-error name (e.g.
 *   `ERR_NAME_NOT_RESOLVED`); surfaced as the diagnostic `code` for the
 *   developer audience on network/file failures.
 * @param httpStatus The committed response status from `did-navigate`, or `0`
 *   when none (provisional failure before a response).
 * @param _url The URL that was loading; carried to keep the signature stable
 *   for callers and future scheme-specific rules.
 * @returns `"ok"` when the load did not fail, else a classified
 *   {@link PreviewPageError}.
 */
export function classifyLoadResult(
  isMainFrame: boolean,
  errorCode: number,
  errorDescription: string,
  httpStatus: number,
  _url: string,
): "ok" | PreviewPageError {
  // A sub-frame (ad iframe, embedded widget) failing must not blank the page.
  if (!isMainFrame) return "ok";

  // HTTP errors win: the navigation committed a response, so the status is the
  // authoritative signal even if a benign code rode alongside it.
  if (httpStatus >= 400) {
    return { kind: "http", status: httpStatus, message: httpMessage(httpStatus) };
  }

  // Redirects and user-initiated cancels surface as ERR_ABORTED; not a failure.
  if (errorCode === 0 || errorCode === ERR_ABORTED) return "ok";

  const code = errorDescription.length > 0 ? errorDescription : undefined;

  if (errorCode === ERR_FILE_NOT_FOUND) {
    return { kind: "file-not-found", code, message: COPY.fileMissing };
  }

  // Any other main-frame load error (DNS, offline, connection refused/reset,
  // generic ERR_FAILED) reads to the user as "can't reach this site".
  return { kind: "network", code, message: COPY.network };
}

/** Builds the crash error surfaced when a guest renderer process is gone. */
export function crashError(): PreviewPageError {
  return { kind: "crash", message: COPY.crash };
}

/** Maps an HTTP error status onto its plain-language headline. */
function httpMessage(status: number): string {
  if (status === 404) return COPY.notFound;
  if (status >= 500) return COPY.serverError;
  return COPY.httpOther;
}
