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

  autoUpdater.on("update-downloaded", async (info) => {
    const window =
      BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (!window) return;

    const { response } = await dialog.showMessageBox(window, {
      type: "info",
      title: "Update Ready",
      message: `Version ${info.version} has been downloaded. Restart to apply.`,
      buttons: ["Restart Now", "Later"],
      defaultId: 0,
    });

    if (response === 0) {
      autoUpdater.quitAndInstall();
    }
  });

  autoUpdater.on("error", (err) => {
    console.error("[auto-updater] Error checking for updates:", err.message);
  });

  const checkForUpdates = async (): Promise<void> => {
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      console.error("[auto-updater] checkForUpdates failed:", err);
    }
  };

  // Initial check shortly after launch (give the window time to load)
  setTimeout(checkForUpdates, 10_000);

  // Periodic checks
  setInterval(checkForUpdates, CHECK_INTERVAL_MS);
}
