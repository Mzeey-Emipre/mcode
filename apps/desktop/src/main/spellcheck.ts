/**
 * Electron spellcheck integration.
 * Enables the built-in Chromium spellchecker and intercepts context-menu
 * events to capture misspelled words and suggestions, forwarding them
 * to the renderer via IPC.
 *
 * IPC handlers for word replacement and dictionary management are registered
 * separately in registerIpcHandlers() (main.ts) since ipcMain.handle must
 * only be called once per channel.
 */

import { type BrowserWindow, session } from "electron";

/** Data sent to the renderer when the user right-clicks in an editable area. */
export interface SpellcheckContextMenuData {
  readonly x: number;
  readonly y: number;
  readonly misspelledWord: string;
  readonly suggestions: readonly string[];
  readonly selectionText: string;
  readonly isEditable: boolean;
  readonly editFlags: {
    readonly canCut: boolean;
    readonly canCopy: boolean;
    readonly canPaste: boolean;
    readonly canSelectAll: boolean;
  };
}

/**
 * Enable the spellchecker and attach the context-menu listener to a window.
 * Safe to call multiple times (e.g. on macOS activate) - the listener is
 * scoped to the window's webContents and cleaned up on window close.
 */
export function setupSpellcheck(win: BrowserWindow): void {
  // Enable the built-in Hunspell spellchecker for British English.
  // Calling this multiple times is a no-op if the languages haven't changed.
  session.defaultSession.setSpellCheckerLanguages(["en-GB"]);

  // Intercept every right-click and forward spelling data to the renderer.
  const handleContextMenu = (
    event: Electron.Event,
    params: Electron.ContextMenuParams,
  ): void => {
    if (win.isDestroyed()) return;

    // Only handle editable areas where our custom spellcheck menu applies.
    // Non-editable areas (links, images, sidebar elements) keep Chromium's
    // native context menu so they remain usable.
    if (!params.isEditable) return;

    // Suppress the native menu here (main process) rather than via
    // e.preventDefault() in the renderer. Doing it in the renderer tells
    // Chromium the event is handled and it skips sending ShowContextMenu to
    // the browser process, so this handler would never fire.
    event.preventDefault();

    const data: SpellcheckContextMenuData = {
      x: params.x,
      y: params.y,
      misspelledWord: params.misspelledWord,
      suggestions: params.dictionarySuggestions,
      selectionText: params.selectionText,
      isEditable: params.isEditable,
      editFlags: {
        canCut: params.editFlags.canCut,
        canCopy: params.editFlags.canCopy,
        canPaste: params.editFlags.canPaste,
        canSelectAll: params.editFlags.canSelectAll,
      },
    };

    win.webContents.send("spellcheck:context-menu", data);
  };

  win.webContents.on("context-menu", handleContextMenu);

  // Clean up the listener while webContents is still alive. We listen on
  // `close` (fires before destruction) rather than `closed` (fires after) —
  // touching `win.webContents` from a `closed` handler throws
  // "Object has been destroyed" and crashes the main process on app exit.
  // We also guard with isDestroyed() because some shutdown paths (e.g. the
  // OS killing the renderer process) destroy webContents before `close` fires.
  win.once("close", () => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.removeListener("context-menu", handleContextMenu);
    }
  });
}
