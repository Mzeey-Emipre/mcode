import type { BrowserWindow } from "electron";

import { openExternalUrl } from "./external-url.js";

/** Install popup and navigation restrictions for the main application window. */
export function installMainWindowNavigationPolicy(
  window: BrowserWindow,
  openUrl: (url: string) => void = openExternalUrl,
): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    openUrl(url);
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    const currentUrl = window.webContents.getURL();
    try {
      const current = new URL(currentUrl);
      const target = new URL(url);
      if (current.origin !== "null" && current.origin === target.origin) return;
    } catch {
      // Parse errors fall through to the navigation block.
    }
    event.preventDefault();
    openUrl(url);
  });
}
