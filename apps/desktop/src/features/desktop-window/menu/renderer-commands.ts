import { BrowserWindow } from "electron";

/** Commands sent by native menu items to the renderer. */
export type DesktopRendererCommand =
  | "workspace.new"
  | "thread.new"
  | "sidebar.toggle"
  | "rightPanel.toggle"
  | "settings.keyboard"
  | "settings.about";

/** Window lookup dependencies used to route native menu commands. */
export interface RendererCommandWindowLookup {
  /** Return the focused window, if one exists. */
  readonly getFocusedWindow: () => BrowserWindow | null;
  /** Return the current main window, if one exists. */
  readonly getMainWindow: () => BrowserWindow | null;
}

/** Send an allowlisted renderer command to the focused or main window. */
export function sendDesktopRendererCommand(
  command: DesktopRendererCommand,
  lookup: RendererCommandWindowLookup,
): void {
  const target = lookup.getFocusedWindow() ?? lookup.getMainWindow();
  if (!target || target.isDestroyed()) return;
  target.webContents.send("desktop:command", command);
}
