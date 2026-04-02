/**
 * Electron preload script.
 * Exposes the `desktopBridge` API to the renderer via contextBridge,
 * providing access to native OS features (dialogs, clipboard, editors)
 * and the server connection URL.
 */

import { contextBridge, ipcRenderer, webFrame, webUtils } from "electron";

/**
 * Stream port callback registry.
 * The preload receives a MessagePort via webContents.postMessage('stream-port')
 * and forwards messages to the registered callback in the renderer world.
 *
 * Messages arriving before the callback is registered are buffered and
 * flushed in FIFO order once onStreamEvent is called.
 */
let streamCallback: ((data: unknown) => void) | null = null;
const streamQueue: unknown[] = [];

ipcRenderer.on("stream-port", (event) => {
  const port = event.ports[0];
  if (!port) return;

  port.onmessage = (e: MessageEvent) => {
    if (streamCallback) {
      streamCallback(e.data);
    } else {
      streamQueue.push(e.data);
    }
  };
  port.start();
});

contextBridge.exposeInMainWorld("desktopBridge", {
  /** Get the WebSocket URL (with auth token) for connecting to the server. */
  getServerUrl: (): Promise<string> => ipcRenderer.invoke("get-server-url"),

  /** Show a native open-directory dialog. Returns the selected path or null. */
  showOpenDialog: (opts: Record<string, unknown>): Promise<string | null> =>
    ipcRenderer.invoke("show-open-dialog", opts),

  /** Open a directory in the specified editor. */
  openInEditor: (editor: string, path: string): Promise<void> =>
    ipcRenderer.invoke("open-in-editor", editor, path),

  /** Open a directory in the system file explorer. */
  openInExplorer: (path: string): Promise<void> =>
    ipcRenderer.invoke("open-in-explorer", path),

  /** Open a URL in the default browser (https only). */
  openExternalUrl: (url: string): Promise<void> =>
    ipcRenderer.invoke("open-external-url", url),

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

  /** Register a callback for streaming events received via MessagePort. */
  onStreamEvent: (callback: (data: unknown) => void): void => {
    streamCallback = callback;
    // Flush any messages that arrived before the callback was registered
    while (streamQueue.length > 0) {
      callback(streamQueue.shift()!);
    }
  },

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
});
