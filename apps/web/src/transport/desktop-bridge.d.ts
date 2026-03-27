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
  openInEditor(editor: string, dirPath: string): void;
  /** Open the OS file explorer at the given directory. */
  openInExplorer(dirPath: string): void;
  /** Open a URL in the default browser. */
  openExternalUrl(url: string): void;
  /** Return a list of detected editor names on the system. */
  detectEditors(): Promise<string[]>;
  /** Read an image from the system clipboard. Returns metadata or null. */
  readClipboardImage(): Promise<AttachmentMeta | null>;
  /** Return the file path for logging output. */
  getLogPath(): string;
  /** Return recent log lines. */
  getRecentLogs(lines: number): string;
  /** Map a browser File object to its real filesystem path. */
  getPathForFile(file: File): string;
}

declare global {
  interface Window {
    desktopBridge?: DesktopBridge;
  }
}

export {};
