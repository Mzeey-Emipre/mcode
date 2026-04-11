import type { AttachmentMeta } from "./types";

/**
 * Thin bridge exposed by the Electron preload script for native
 * desktop operations that cannot go through the WebSocket transport
 * (file dialogs, clipboard, editor launching, etc.).
 */
interface DesktopBridge {
  /** Return the URL of the local mcode server (e.g. ws://localhost:PORT). */
  getServerUrl(): Promise<string>;
  /** Open a native folder-picker dialog. Returns the selected path or null. */
  showOpenDialog(options: { title?: string }): Promise<string | null>;
  /** Launch an external editor at the given directory. */
  openInEditor(editor: string, dirPath: string): Promise<void>;
  /** Open the OS file explorer at the given directory. */
  openInExplorer(dirPath: string): Promise<void>;
  /** Open a URL in the default browser. */
  openExternalUrl(url: string): Promise<void>;
  /** Return a list of detected editor names on the system. */
  detectEditors(): Promise<string[]>;
  /** Read an image from the system clipboard. Returns metadata or null. */
  readClipboardImage(): Promise<AttachmentMeta | null>;
  /** Save a clipboard file blob to disk. Returns metadata or null. */
  saveClipboardFile(buffer: Uint8Array, mimeType: string, fileName: string): Promise<AttachmentMeta | null>;
  /** Return the file path for logging output. */
  getLogPath(): Promise<string>;
  /** Return recent log lines. */
  getRecentLogs(lines: number): Promise<string>;
  /** Map a browser File object to its real filesystem path. */
  getPathForFile(file: File): string;
  /** Register a callback for streaming events received via MessagePort. */
  onStreamEvent(callback: (data: unknown) => void): void;
  /** Clear Blink's in-memory resource caches (images, scripts, CSS).
   * Typically called after a thread switch to reclaim memory. */
  clearRendererCache(): void;
  /** Return total bytes held in Blink's resource cache. */
  getRendererCacheBytes(): number;
  /** Open settings.json in the OS default editor. Resolves to an empty string on success. */
  openSettingsFile(): Promise<string>;
  /** Open keybindings.json in the OS default editor. Creates the file if it doesn't exist. */
  openKeybindingsFile(): Promise<string>;
}

declare global {
  interface Window {
    desktopBridge?: DesktopBridge;
  }
}

export {};
