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
    // Suppress Chromium's native context menu. We must do this here (main process)
    // rather than via e.preventDefault() in the renderer, because calling
    // preventDefault() on the renderer's DOM contextmenu event tells Chromium
    // the event is handled - it then skips sending ShowContextMenu to the browser
    // process, so this handler would never fire.
    event.preventDefault();

    if (win.isDestroyed()) return;

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

  // Clean up the listener when the window closes to prevent leaks.
  win.once("closed", () => {
    win.webContents.removeListener("context-menu", handleContextMenu);
  });
}
