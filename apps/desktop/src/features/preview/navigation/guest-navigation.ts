import type { WebContents } from "electron";

/** Result of one URL load against an adopted Preview guest. */
export type PreviewGuestLoadResult =
  | { readonly status: "committed"; readonly url: string }
  | {
      readonly status: "failed";
      readonly url: string;
      readonly errorCode?: string;
      readonly errorNumber?: number;
    };

function errorRecord(cause: unknown): Record<string, unknown> {
  return typeof cause === "object" && cause !== null ? cause as Record<string, unknown> : {};
}

function currentGuestUrl(webContents: WebContents, fallback: string): string {
  const currentUrl = webContents.getURL();
  return currentUrl.length > 0 ? currentUrl : fallback;
}

function isCommittedAbortedLoad(
  cause: unknown,
  webContents: WebContents,
  requestedUrl: string,
  previousUrl: string,
): boolean {
  const error = errorRecord(cause);
  if (error.code !== "ERR_ABORTED" && error.errno !== -3) return false;
  const committedUrl = webContents.getURL();
  if (!committedUrl || committedUrl.startsWith("about:") || committedUrl.startsWith("chrome-error:")) {
    return false;
  }
  return committedUrl === requestedUrl || committedUrl !== previousUrl;
}

/** Loads one URL and treats an aborted load as successful only after a usable document commits. */
export async function loadPreviewGuestUrl(
  webContents: WebContents,
  requestedUrl: string,
): Promise<PreviewGuestLoadResult> {
  const previousUrl = webContents.getURL();
  try {
    await webContents.loadURL(requestedUrl);
    return { status: "committed", url: currentGuestUrl(webContents, requestedUrl) };
  } catch (cause) {
    if (isCommittedAbortedLoad(cause, webContents, requestedUrl, previousUrl)) {
      return { status: "committed", url: currentGuestUrl(webContents, requestedUrl) };
    }
    const error = errorRecord(cause);
    const errorCode = typeof error.code === "string" && error.code.length > 0
      ? error.code.slice(0, 128)
      : undefined;
    const errorNumber = typeof error.errno === "number" && Number.isFinite(error.errno)
      ? error.errno
      : undefined;
    return {
      status: "failed",
      url: currentGuestUrl(webContents, previousUrl),
      ...(errorCode === undefined ? {} : { errorCode }),
      ...(errorNumber === undefined ? {} : { errorNumber }),
    };
  }
}
