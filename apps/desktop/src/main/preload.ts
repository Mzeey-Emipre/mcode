/**
 * Electron preload script.
 * Exposes the `desktopBridge` API to the renderer via contextBridge,
 * providing access to native OS features (dialogs, clipboard, editors)
 * and the server connection URL.
 */

import { contextBridge, ipcRenderer, webFrame, webUtils } from "electron";

contextBridge.exposeInMainWorld("desktopBridge", {
  /** Get the WebSocket URL (with auth token) and IPC path for connecting to the server. */
  getServerUrl: (): Promise<{ url: string; ipcPath: string }> => ipcRenderer.invoke("get-server-url"),

  /** Show a native open-directory dialog. Returns the selected path or null. */
  showOpenDialog: (opts: Record<string, unknown>): Promise<string | null> =>
    ipcRenderer.invoke("show-open-dialog", opts),

  /**
   * Open a path in the specified editor. If `line` is provided, the editor
   * jumps to that line (file targets only — for directory targets the line
   * is silently ignored).
   */
  openInEditor: (editor: string, path: string, line?: number): Promise<void> =>
    ipcRenderer.invoke("open-in-editor", editor, path, line),

  /** Open a directory in the system file explorer. */
  openInExplorer: (path: string): Promise<void> =>
    ipcRenderer.invoke("open-in-explorer", path),

  /** Open a URL in the default browser (https, http, mailto, or resolved mcode-workspace file targets). */
  openExternalUrl: (url: string, workspacePath?: string | null): Promise<void> =>
    ipcRenderer.invoke("open-external-url", url, workspacePath ?? null),

  /** Detect which supported editors are installed. */
  detectEditors: (): Promise<string[]> => ipcRenderer.invoke("detect-editors"),

  /** Read an image from the clipboard and save it as a temp JPEG. */
  readClipboardImage: (): Promise<unknown> =>
    ipcRenderer.invoke("read-clipboard-image"),

  /** Save a file blob from the clipboard to a temp location. */
  saveClipboardFile: (buffer: Uint8Array, mimeType: string, fileName: string): Promise<unknown> =>
    ipcRenderer.invoke("save-clipboard-file", buffer, mimeType, fileName),

  /** Get the absolute path to the log directory. */
  getLogPath: (): Promise<string> => ipcRenderer.invoke("get-log-path"),

  /** Read the last N lines from the most recent log file. */
  getRecentLogs: (lines: number): Promise<string> =>
    ipcRenderer.invoke("get-recent-logs", lines),

  /** Resolve the native file path for a File object (drag-and-drop). */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  /** Clear Blink's in-memory resource caches (images, scripts, CSS).
   * Typically called after a thread switch to reclaim memory. */
  clearRendererCache: (): void => webFrame.clearCache(),

  /** Return total bytes held in Blink's resource cache (images, scripts, CSS, fonts). */
  getRendererCacheBytes: (): number => {
    const { images, scripts, cssStyleSheets, xslStyleSheets, fonts, other } =
      webFrame.getResourceUsage();
    return (
      images.size + scripts.size + cssStyleSheets.size +
      xslStyleSheets.size + fonts.size + other.size
    );
  },

  /** Open settings.json in the OS default editor. Resolves to an empty string on success. */
  openSettingsFile: (): Promise<string> =>
    ipcRenderer.invoke("open-settings-file"),

  /** Open keybindings.json in the OS default editor. Creates the file if it doesn't exist. */
  openKeybindingsFile: (): Promise<string> =>
    ipcRenderer.invoke("open-keybindings-file"),

  /** Spellcheck context menu and dictionary management. */
  spellcheck: {
    /** Listen for context-menu events with spelling data from the main process. Returns the listener reference for targeted cleanup. */
    onContextMenu(callback: (data: unknown) => void) {
      const listener = (_event: unknown, data: unknown) => callback(data);
      ipcRenderer.on("spellcheck:context-menu", listener);
      return listener;
    },
    /** Remove a specific context-menu listener (avoids removing other listeners on the channel). */
    offContextMenu(listener: (...args: unknown[]) => void) {
      ipcRenderer.removeListener("spellcheck:context-menu", listener);
    },
    /** Replace the misspelled word under the cursor with the given word. */
    replaceMisspelling(word: string): Promise<void> {
      return ipcRenderer.invoke("spellcheck:replace-misspelling", word);
    },
    /** Add a word to the user's custom dictionary. */
    addToDictionary(word: string): Promise<void> {
      return ipcRenderer.invoke("spellcheck:add-to-dictionary", word);
    },
    /** Paste from clipboard via Electron's native webContents.paste(). */
    paste(): Promise<void> {
      return ipcRenderer.invoke("spellcheck:paste");
    },
  },

  /** App version and auto-update controls. */
  app: {
    /** Read the running app version (from package.json at build time). */
    getVersion(): Promise<string> {
      return ipcRenderer.invoke("app:get-version");
    },
    /** Get the most recent update status without triggering a new check. */
    getUpdateStatus(): Promise<unknown> {
      return ipcRenderer.invoke("app:get-update-status");
    },
    /** Manually trigger a check for updates. Resolves with the resulting status. */
    checkForUpdates(): Promise<unknown> {
      return ipcRenderer.invoke("app:check-for-updates");
    },
    /** Quit and install a downloaded update. Returns false if nothing to install. */
    installUpdate(): Promise<boolean> {
      return ipcRenderer.invoke("app:install-update");
    },
    /** Trigger download of a discovered update (when auto-download is off). */
    downloadUpdate(): Promise<void> {
      return ipcRenderer.invoke("app:download-update");
    },
    /**
     * Switch the running updater to a new release line and immediately check.
     * When `allowDowngrade` is true, the next install is allowed to be older
     * than the running version (used by the nightly→stable confirmation flow).
     */
    applyReleaseLine(payload: {
      releaseLine: "stable" | "nightly";
      allowDowngrade?: boolean;
    }): Promise<unknown> {
      return ipcRenderer.invoke("app:apply-release-line", payload);
    },
    /** Subscribe to push updates of update-status. Returns the listener for cleanup. */
    onUpdateStatus(callback: (status: unknown) => void) {
      const listener = (_event: unknown, status: unknown) => callback(status);
      ipcRenderer.on("app:update-status", listener);
      return listener;
    },
    /** Remove a previously registered update-status listener. */
    offUpdateStatus(listener: (...args: unknown[]) => void) {
      ipcRenderer.removeListener("app:update-status", listener);
    },
  },

  /**
   * Embedded thread preview (Electron BrowserView). No-op channels in web builds
   * without this namespace; the renderer checks `desktopBridge?.preview` before use.
   */
  preview: {
    sync(payload: {
      visible: boolean;
      bounds: { x: number; y: number; width: number; height: number } | null;
      threadId?: string | null;
      resumeUrlHint?: string | null;
      workspaceId?: string | null;
    }): Promise<void> {
      return ipcRenderer.invoke("preview:sync", payload);
    },
    navigate(url: string, workspacePath?: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
      return ipcRenderer.invoke("preview:navigate", url, workspacePath ?? null);
    },
    goBack(): Promise<boolean> {
      return ipcRenderer.invoke("preview:go-back");
    },
    goForward(): Promise<boolean> {
      return ipcRenderer.invoke("preview:go-forward");
    },
    reload(): Promise<void> {
      return ipcRenderer.invoke("preview:reload");
    },
    openExternal(): Promise<void> {
      return ipcRenderer.invoke("preview:open-external");
    },
    openGuestDevTools(): Promise<void> {
      return ipcRenderer.invoke("preview:open-guest-devtools");
    },
    getNavigationState(): Promise<{ canGoBack: boolean; canGoForward: boolean }> {
      return ipcRenderer.invoke("preview:get-navigation-state");
    },
    /** Capture the visible preview viewport as a PNG for attaching to the composer. */
    capturePictureReference(): Promise<unknown> {
      return ipcRenderer.invoke("preview:capture-picture-reference");
    },
    /** Drag to select a region; captures that part of the preview as PNG. */
    capturePictureReferenceRegion(): Promise<unknown> {
      return ipcRenderer.invoke("preview:capture-picture-region");
    },
    /** Hover to highlight, then click an element; captures its bounds as PNG with DOM context. */
    capturePictureReferenceElementPick(): Promise<unknown> {
      return ipcRenderer.invoke("preview:capture-picture-element-pick");
    },
    /** Structured page context for the composer fence without capturing a PNG. */
    capturePageContext(): Promise<unknown> {
      return ipcRenderer.invoke("preview:capture-context-reference");
    },
    releaseBrowserCaptureSpills(paths: readonly string[]): Promise<void> {
      return ipcRenderer.invoke("preview:release-browser-capture-spill", [...paths]);
    },
    /**
     * Subscribe to the single page-status channel: the full PreviewPageStatus
     * (url, title, favicon, phase, error?) emitted once per change for the
     * active tab. Replaces the old loading-state / did-navigate /
     * did-update-favicon trio.
     */
    onPageStatus(callback: (status: import("@mcode/contracts").PreviewPageStatus) => void) {
      const listener = (_event: unknown, status: import("@mcode/contracts").PreviewPageStatus) =>
        callback(status);
      ipcRenderer.on("preview:page-status", listener);
      return () => ipcRenderer.removeListener("preview:page-status", listener);
    },
    /** Cancel any in-progress capture operation (region or element-pick). */
    cancelCapture(): Promise<void> {
      return ipcRenderer.invoke("preview:cancel-capture");
    },
    /**
     * Subscribe to keyboard chords forwarded from the guest WebContents.
     * Fires whenever the guest's `before-input-event` matches a modifier
     * combo we want the host to handle (e.g. Ctrl+Shift+D for the capture
     * dock). The combo string mirrors the keybinding JSON format ("mod+shift+d").
     */
    onShortcutFired(callback: (combo: string) => void) {
      const listener = (_event: unknown, combo: string) => callback(combo);
      ipcRenderer.on("preview:shortcut-fired", listener);
      return () => ipcRenderer.removeListener("preview:shortcut-fired", listener);
    },
    /** Read the live perf counter bag (dev HUD only). */
    getPerfCounters(): Promise<unknown> {
      return ipcRenderer.invoke("preview:get-perf-counters");
    },
    /**
     * Phase D: adopt a renderer-hosted <webview> into the host bridge so the
     * Codex browser-use pipe can drive it via executeCdp. The renderer reads
     * the guest's webContentsId via `webview.getWebContentsId()` after
     * `did-attach` fires, then forwards it here.
     */
    adoptWebview(payload: {
      webContentsId: number;
      threadId: string;
      tabId: string;
    }): Promise<unknown> {
      return ipcRenderer.invoke("preview:adopt-webview", payload);
    },
    releaseWebview(payload: { threadId: string; tabId: string }): Promise<unknown> {
      return ipcRenderer.invoke("preview:release-webview", payload);
    },
    /**
     * Phase G design mode: stretch the panel to one of the named viewport
     * presets ("phone" | "tablet" | "desktop") or pass explicit dimensions.
     * Use design.reset() to restore the bounds the React shell last synced.
     */
    design: {
      setViewport(payload: {
        presetId?: string;
        widthOverride?: number;
        heightOverride?: number;
      }): Promise<unknown> {
        return ipcRenderer.invoke("preview:design.set-viewport", payload);
      },
      resetViewport(): Promise<unknown> {
        return ipcRenderer.invoke("preview:design.reset-viewport");
      },
      setInspect(enabled: boolean): Promise<unknown> {
        return ipcRenderer.invoke("preview:design.set-inspect", { enabled });
      },
    },
    /**
     * Multi-tab control surface (Phase A of the in-app browser rewrite).
     * Phase A keeps a single backing BrowserView per window; these methods
     * give the renderer a stable contract for tab list / mutations so the UI
     * can ship tab affordances before the real per-tab backing lands.
     */
    tabs: {
      list(threadId: string): Promise<unknown> {
        return ipcRenderer.invoke("preview:tabs.list", { threadId });
      },
      create(threadId: string, activate = true): Promise<unknown> {
        return ipcRenderer.invoke("preview:tabs.create", { threadId, activate });
      },
      activate(threadId: string, tabId: string): Promise<unknown> {
        return ipcRenderer.invoke("preview:tabs.activate", { threadId, tabId });
      },
      close(threadId: string, tabId: string): Promise<unknown> {
        return ipcRenderer.invoke("preview:tabs.close", { threadId, tabId });
      },
      onUpdated(callback: (payload: unknown) => void): () => void {
        const listener = (_event: unknown, payload: unknown) => callback(payload);
        ipcRenderer.on("preview:tabs-updated", listener);
        return () => ipcRenderer.removeListener("preview:tabs-updated", listener);
      },
    },
  },

  /** IPC push transport relayed from the main process. */
  ipc: {
    /** Listen for push messages forwarded by the main process IPC relay. */
    onPush(callback: (data: unknown) => void) {
      ipcRenderer.on("ipc-push-message", (_event: unknown, data: unknown) => callback(data));
    },
    /** Listen for IPC connection close events. */
    onDisconnect(callback: () => void) {
      ipcRenderer.on("ipc-push-disconnect", () => callback());
    },
    /** Remove all IPC push listeners. */
    off() {
      ipcRenderer.removeAllListeners("ipc-push-message");
      ipcRenderer.removeAllListeners("ipc-push-disconnect");
    },
  },
});
