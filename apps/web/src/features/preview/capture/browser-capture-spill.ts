import type { AttachedBrowserCapture, McodeBrowserCapture } from "@mcode/contracts";

/**
 * Collects `spillAppDataPath` values from browser capture rows for cleanup when queued
 * messages are removed or similar explicit discard paths.
 */
export function collectBrowserCaptureSpillPaths(rows: readonly AttachedBrowserCapture[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    if (row.schemaVersion === 2 && row.spillAppDataPath) {
      out.push(row.spillAppDataPath);
    }
  }
  return out;
}

/**
 * Collects spill paths from composer `PendingAttachment` rows (v2 captures with `spillAppDataPath`).
 */
export function collectSpillPathsFromPendingAttachments(
  attachments: readonly { browserCapture?: McodeBrowserCapture }[],
): string[] {
  const out: string[] = [];
  for (const att of attachments) {
    const c = att.browserCapture;
    if (c?.schemaVersion === 2 && c.spillAppDataPath) {
      out.push(c.spillAppDataPath);
    }
  }
  return out;
}

/**
 * Removes spill JSON files under the Mcode app data directory (`browser-capture-spill/`).
 */
export async function releaseBrowserCaptureSpills(paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  const preview = window.desktopBridge?.preview;
  if (!preview?.releaseBrowserCaptureSpills) return;
  await preview.releaseBrowserCaptureSpills(paths);
}
