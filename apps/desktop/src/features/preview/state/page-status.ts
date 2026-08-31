/**
 * Pure reducer for the embedded preview's page state. This is the only place
 * `PreviewPageStatus` transitions; navigation, title, favicon, loading, error,
 * and discard all flow through here so the host emits one consistent object on
 * the single `preview:page-status` channel.
 */

import type { PreviewPageStatus, PreviewPageError } from "@mcode/contracts";

/** Discrete inputs the host derives from guest webContents events. */
export type PageStatusEvent =
  /** did-start-loading / navigate kickoff: enter loading, clear favicon + error. */
  | { type: "load-start"; url?: string | null }
  /** did-navigate / did-navigate-in-page: adopt the committed URL (and title). */
  | { type: "navigated"; url: string | null; title?: string | null }
  /** page-title-updated. */
  | { type: "title"; title: string | null }
  /** page-favicon-updated. */
  | { type: "favicon"; favicon: string | null }
  /** did-stop-loading / did-finish-load: settle to loaded (unless already error). */
  | { type: "load-stop" }
  /**
   * Classified failure (W1): enter error and clear the loading affordance.
   * `url` carries the failed address (from did-fail-load's validatedURL) so the
   * error panel can show it and offer "Open in browser" / "Edit URL" even when
   * the navigation never committed a URL.
   */
  | { type: "load-error"; error: PreviewPageError; url?: string | null }
  /** Memory-saver eviction (W3): enter discarded, keep cold chrome. */
  | { type: "discard" }
  /** Tab/thread switch: replace the whole status with the activated tab's chrome. */
  | { type: "reset"; status: PreviewPageStatus };

/** Blank starting status: nothing loaded, no spinner. */
export function initialPageStatus(): PreviewPageStatus {
  return { url: null, title: null, favicon: null, phase: "loaded" };
}

/** Returns the next status for `event`. Pure: never mutates `prev`. */
export function pageStatusReducer(
  prev: PreviewPageStatus,
  event: PageStatusEvent,
): PreviewPageStatus {
  switch (event.type) {
    case "load-start":
      return pageStatusForLoadStart(prev, event);
    case "navigated":
      return pageStatusForNavigation(prev, event);
    case "title":
      return { ...prev, title: event.title };
    case "favicon":
      return { ...prev, favicon: event.favicon };
    case "load-stop":
      return pageStatusForLoadStop(prev);
    case "load-error":
      return pageStatusForLoadError(prev, event);
    case "discard":
      return { ...prev, phase: "discarded" };
    case "reset":
      return event.status;
  }
}

function pageStatusForLoadStart(
  prev: PreviewPageStatus,
  event: Extract<PageStatusEvent, { type: "load-start" }>,
): PreviewPageStatus {
  return {
    url: event.url !== undefined ? event.url : prev.url,
    title: prev.title,
    favicon: null,
    phase: "loading",
  };
}

function pageStatusForNavigation(
  prev: PreviewPageStatus,
  event: Extract<PageStatusEvent, { type: "navigated" }>,
): PreviewPageStatus {
  return {
    ...prev,
    url: event.url,
    title: hasPageTitle(event.title) ? event.title : prev.title,
    error: undefined,
  };
}

function hasPageTitle(title: string | null | undefined): title is string {
  return title !== undefined && title !== null && title.length > 0;
}

function pageStatusForLoadStop(prev: PreviewPageStatus): PreviewPageStatus {
  return prev.phase === "error" ? prev : { ...prev, phase: "loaded" };
}

function pageStatusForLoadError(
  prev: PreviewPageStatus,
  event: Extract<PageStatusEvent, { type: "load-error" }>,
): PreviewPageStatus {
  return {
    ...prev,
    url: event.url !== undefined ? event.url : prev.url,
    phase: "error",
    favicon: null,
    error: event.error,
  };
}
