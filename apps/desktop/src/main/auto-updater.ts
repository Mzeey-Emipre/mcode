/**
 * Configures electron-updater to check GitHub Releases for new versions.
 * Checks once on launch, then every 4 hours while running.
 * Downloads silently; notifies the user when an update is ready to install.
 */

import { autoUpdater } from "electron-updater";
import { app, dialog, BrowserWindow } from "electron";

/** Interval between update checks (4 hours). */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** Initializes auto-update checks. Call once after app "ready" fires. */
export function initAutoUpdater(): void {
  // In dev, there's no packaged app to update
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-downloaded", (info) => {
    const window = BrowserWindow.getFocusedWindow();
    if (!window) return;

    dialog
      .showMessageBox(window, {
        type: "info",
        title: "Update Ready",
        message: `Version ${info.version} has been downloaded. Restart to apply.`,
        buttons: ["Restart Now", "Later"],
        defaultId: 0,
      })
      .then(({ response }) => {
        if (response === 0) {
          autoUpdater.quitAndInstall();
        }
      });
  });

  autoUpdater.on("error", (err) => {
    console.error("[auto-updater] Error checking for updates:", err.message);
  });

  // Initial check shortly after launch (give the window time to load)
  setTimeout(() => autoUpdater.checkForUpdates(), 10_000);

  // Periodic checks
  setInterval(() => autoUpdater.checkForUpdates(), CHECK_INTERVAL_MS);
}
