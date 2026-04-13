/**
 * Electron preload script.
 * Exposes the `desktopBridge` API to the renderer via contextBridge,
 * providing access to native OS features (dialogs, clipboard, editors)
 * and the server connection URL.
 */

import { contextBridge, ipcRenderer, webFrame, webUtils } from "electron";
// Node.js built-in — only available in the Electron preload context
import { connect as netConnect } from "net";

/**
 * Parse length-prefixed frames from a Node.js net.Socket.
 * Frame format: [4-byte BE length][JSON payload].
 */
function createFrameParser(onMessage: (data: unknown) => void) {
  let buffer = Buffer.alloc(0);

  return (chunk: Buffer) => {
    buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);

    while (buffer.length >= 4) {
      const frameLen = buffer.readUInt32BE(0);
      if (buffer.length < 4 + frameLen) break;

      const json = buffer.subarray(4, 4 + frameLen).toString("utf-8");
      buffer = buffer.subarray(4 + frameLen);

      try {
        onMessage(JSON.parse(json));
      } catch (e) { console.warn("[ipc] Malformed frame:", e); }
    }
  };
}

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

  /** Open a URL in the default browser (https, http, mailto). */
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

  /** IPC push transport for high-throughput streaming. */
  ipc: {
    /** Connect to the server's IPC push endpoint. */
    connect(path: string) {
      let messageCallback: ((data: unknown) => void) | null = null;
      let disconnectCallback: (() => void) | null = null;

      const socket = netConnect(path);
      const parser = createFrameParser((data) => messageCallback?.(data));
      socket.on("data", parser);
      // Let "close" be the single source of disconnect notification.
      // Node.js guarantees "close" fires after "error" + destroy().
      socket.on("error", () => socket.destroy());
      socket.on("close", () => disconnectCallback?.());

      return {
        onMessage(cb: (data: unknown) => void) { messageCallback = cb; },
        onDisconnect(cb: () => void) { disconnectCallback = cb; },
        close() { socket.end(); socket.destroy(); },
      };
    },
  },
});
