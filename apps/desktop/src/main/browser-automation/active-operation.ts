import type { WebContents } from "electron";

const activeDepthByGuest = new WeakMap<object, number>();

/** Returns true only while an exact main-process automation operation runs on this guest. */
export function isBrowserAutomationAgentOperationActive(webContents: WebContents): boolean {
  return (activeDepthByGuest.get(webContents) ?? 0) > 0;
}

/** Records one exact automation operation entering or leaving a guest. */
export function updateBrowserAutomationAgentOperationDepth(
  webContents: WebContents,
  delta: 1 | -1,
): void {
  const next = (activeDepthByGuest.get(webContents) ?? 0) + delta;
  if (next > 0) activeDepthByGuest.set(webContents, next);
  else activeDepthByGuest.delete(webContents);
}
