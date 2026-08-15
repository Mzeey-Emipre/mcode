import { app, type BrowserWindow } from "electron";

import { isDesktopDev } from "../../../main/is-desktop-dev.js";

/** Native window and edit commands accepted from the context-isolated renderer. */
export type DesktopWindowAction =
  | "closeWindow"
  | "quit"
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "selectAll"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset"
  | "toggleFullScreen"
  | "reload"
  | "toggleDevTools";

/** Explicit allowlist for native actions exposed through IPC. */
export const DESKTOP_WINDOW_ACTIONS: ReadonlySet<DesktopWindowAction> =
  new Set([
    "closeWindow",
    "quit",
    "undo",
    "redo",
    "cut",
    "copy",
    "paste",
    "selectAll",
    "zoomIn",
    "zoomOut",
    "zoomReset",
    "toggleFullScreen",
    "reload",
    "toggleDevTools",
  ]);

/** Apply one validated native action to a BrowserWindow. */
export function performDesktopWindowAction(
  window: BrowserWindow,
  action: DesktopWindowAction,
): void {
  switch (action) {
    case "closeWindow":
      window.close();
      return;
    case "quit":
      app.quit();
      return;
    case "undo":
      window.webContents.undo();
      return;
    case "redo":
      window.webContents.redo();
      return;
    case "cut":
      window.webContents.cut();
      return;
    case "copy":
      window.webContents.copy();
      return;
    case "paste":
      window.webContents.paste();
      return;
    case "selectAll":
      window.webContents.selectAll();
      return;
    case "zoomIn":
      window.webContents.setZoomLevel(window.webContents.getZoomLevel() + 0.5);
      return;
    case "zoomOut":
      window.webContents.setZoomLevel(window.webContents.getZoomLevel() - 0.5);
      return;
    case "zoomReset":
      window.webContents.setZoomLevel(0);
      return;
    case "toggleFullScreen":
      window.setFullScreen(!window.isFullScreen());
      return;
    case "reload":
      if (isDesktopDev()) window.webContents.reloadIgnoringCache();
      return;
    case "toggleDevTools":
      if (!isDesktopDev()) return;
      if (window.webContents.isDevToolsOpened()) {
        window.webContents.closeDevTools();
      } else {
        window.webContents.openDevTools({ mode: "right" });
      }
  }
}
