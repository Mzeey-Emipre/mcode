import { BrowserWindow, ipcMain } from "electron";

import {
  DESKTOP_WINDOW_ACTIONS,
  performDesktopWindowAction,
  type DesktopWindowAction,
} from "./window-actions.js";

/** Register the authorized IPC bridge for native window actions. */
export function registerDesktopWindowActionHandler(): void {
  ipcMain.handle("window:perform", (event, action: unknown) => {
    if (
      typeof action !== "string" ||
      !DESKTOP_WINDOW_ACTIONS.has(action as DesktopWindowAction)
    ) {
      throw new Error("Invalid desktop window action");
    }
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return;
    performDesktopWindowAction(window, action as DesktopWindowAction);
  });
}
