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

const WINDOW_ACTION_HANDLERS: Readonly<
  Record<Exclude<DesktopWindowAction, "reload" | "toggleDevTools">, (window: BrowserWindow) => void>
> = {
  closeWindow: (window) => window.close(),
  quit: () => app.quit(),
  undo: (window) => window.webContents.undo(),
  redo: (window) => window.webContents.redo(),
  cut: (window) => window.webContents.cut(),
  copy: (window) => window.webContents.copy(),
  paste: (window) => window.webContents.paste(),
  selectAll: (window) => window.webContents.selectAll(),
  zoomIn: (window) => window.webContents.setZoomLevel(window.webContents.getZoomLevel() + 0.5),
  zoomOut: (window) => window.webContents.setZoomLevel(window.webContents.getZoomLevel() - 0.5),
  zoomReset: (window) => window.webContents.setZoomLevel(0),
  toggleFullScreen: (window) => window.setFullScreen(!window.isFullScreen()),
};

/** Apply one validated native action to a BrowserWindow. */
export function performDesktopWindowAction(
  window: BrowserWindow,
  action: DesktopWindowAction,
): void {
  if (action === "reload") return reloadDesktopWindow(window);
  if (action === "toggleDevTools") return toggleDesktopDevTools(window);
  WINDOW_ACTION_HANDLERS[action](window);
}

function reloadDesktopWindow(window: BrowserWindow): void {
  if (isDesktopDev()) window.webContents.reloadIgnoringCache();
}

function toggleDesktopDevTools(window: BrowserWindow): void {
  if (!isDesktopDev()) return;
  if (window.webContents.isDevToolsOpened()) return window.webContents.closeDevTools();
  window.webContents.openDevTools({ mode: "right" });
}
