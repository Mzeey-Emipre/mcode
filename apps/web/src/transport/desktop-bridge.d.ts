import type { AttachmentMeta, OpenInApp } from "./types";
import type { BrowserPerfCounters, BrowserTabSet, McodeBrowserCapture, PreviewPageStatus } from "@mcode/contracts";

/** Discriminated union describing the auto-updater lifecycle state. */
export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string; releaseNotes?: string }
  | { state: "not-available"; version: string }
  | { state: "downloading"; percent: number; bytesPerSecond?: number }
  | { state: "downloaded"; version: string; releaseNotes?: string }
  | { state: "error"; message: string };

/** App version and auto-update controls exposed by the main process. */
interface AppBridge {
  /** Read the running app version (from package.json at build time). */
  getVersion(): Promise<string>;
  /** Get the most recent update status without triggering a new check. */
  getUpdateStatus(): Promise<UpdateStatus>;
  /** Manually trigger a check for updates. Resolves with the resulting status. */
  checkForUpdates(): Promise<UpdateStatus>;
  /** Quit and install a downloaded update. Returns false if nothing to install. */
  installUpdate(): Promise<boolean>;
  /** Trigger download of a discovered update (when auto-download is off). */
  downloadUpdate(): Promise<void>;
  /**
   * Switch the updater release line ("stable" or "nightly") and trigger a
   * check. Pass `allowDowngrade: true` when the user has confirmed a
   * nightly → stable rollback (the install will be older than current).
   */
  applyReleaseLine(payload: {
    releaseLine: "stable" | "nightly";
    allowDowngrade?: boolean;
  }): Promise<UpdateStatus>;
  /** Subscribe to push updates of update-status. Returns the listener for cleanup. */
  onUpdateStatus(callback: (status: UpdateStatus) => void): (...args: unknown[]) => void;
  /** Remove a previously registered update-status listener. */
  offUpdateStatus(listener: (...args: unknown[]) => void): void;
}

/** Bounds for aligning the native BrowserView with a DOM region in the React shell. */
export type PreviewShellBounds = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/** Result of a preview navigation attempt (http, https, and local file paths). */
export type PreviewNavigateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

/** Result of resolving preview navigation input without loading it. */
export type PreviewResolveNavigationResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly error: string };

/** Result of capturing the embedded preview viewport as a PNG for the composer. */
export type PreviewPictureReferenceResult =
  | {
      readonly ok: true;
      readonly meta: AttachmentMeta;
      readonly previewBytes: Uint8Array;
      readonly capture: McodeBrowserCapture;
    }
  | { readonly ok: false; readonly error: string };

/** One marker to draw into a saved annotation screenshot. */
export type PreviewAnnotationSnapshotMarker = {
  readonly displayNumber: number;
  readonly bounds: PreviewShellBounds;
};

/** Overlay data burned into a saved annotation screenshot. */
export type PreviewAnnotationSnapshotRequest = {
  readonly activeDisplayNumber: number;
  readonly activeBounds: PreviewShellBounds;
  readonly markers: readonly PreviewAnnotationSnapshotMarker[];
};

/** Result of capturing preview page context without a PNG (desktop only). */
export type PreviewContextReferenceResult =
  | { readonly ok: true; readonly capture: McodeBrowserCapture }
  | { readonly ok: false; readonly error: string };

/**
 * A localhost port detected as bound by a process on the machine, surfaced in
 * the empty browser as a one-click card. `name` is a best-effort label for the
 * service (e.g. a dev-server framework or the owning process); `online` is the
 * latest reachability probe for `http://localhost:<port>`.
 *
 * The detection backend lands in #613; the renderer treats
 * {@link PreviewBridge.detectLocalPorts} as optional so the empty state
 * degrades to "no ports" until that method exists.
 */
export interface DetectedLocalPort {
  readonly port: number;
  readonly name: string;
  readonly online: boolean;
}

/** Embedded thread preview backed by an Electron BrowserView. */
interface PreviewBridge {
  sync(payload: {
    visible: boolean;
    bounds: PreviewShellBounds | null;
    threadId?: string | null;
    resumeUrlHint?: string | null;
    /** Why a visible panel is asking the native host to hide its BrowserView. */
    hideReason?: "renderer-webview";
    /** Active workspace id; scopes preview spill files under the Mcode app data directory. */
    workspaceId?: string | null;
  }): Promise<void>;
  /** Resolve omnibox input to a safe preview URL without loading it. */
  resolveNavigation(url: string, workspacePath?: string | null): Promise<PreviewResolveNavigationResult>;
  navigate(url: string, workspacePath?: string | null): Promise<PreviewNavigateResult>;
  goBack(): Promise<boolean>;
  goForward(): Promise<boolean>;
  reload(): Promise<void>;
  /** Hard reload that bypasses the guest's HTTP cache (Force reload). */
  forceReload(): Promise<void>;
  /** Clear the preview session's cookies. */
  clearCookies(): Promise<void>;
  /** Clear the preview session's HTTP cache. */
  clearCache(): Promise<void>;
  /** Read the guest's current zoom factor (1 = 100%). */
  getZoom(): Promise<number>;
  /** Set the guest's zoom factor; resolves to the clamped factor actually applied. */
  setZoom(factor: number): Promise<number>;
  openExternal(): Promise<void>;
  /** Open Chrome DevTools attached to the guest WebContents (the embedded site, not the host shell). */
  openGuestDevTools(): Promise<void>;
  /**
   * Subscribe to keyboard chords forwarded from the guest WebContents so the
   * host's keybinding manager can fire app commands while the user is focused
   * inside the preview. The combo string mirrors keybinding JSON ("mod+shift+d").
   * Returns a disposer.
   */
  onShortcutFired(callback: (combo: string) => void): () => void;
  getNavigationState(): Promise<{ canGoBack: boolean; canGoForward: boolean }>;
  /** Captures the visible preview as PNG; desktop only. */
  capturePictureReference(): Promise<PreviewPictureReferenceResult>;
  /** Drag a rectangle on the preview, then capture that region as PNG; desktop only. */
  capturePictureReferenceRegion(): Promise<PreviewPictureReferenceResult>;
  /** Pick an element by hover and click; captures its box as PNG with selector and excerpt; desktop only. */
  capturePictureReferenceElementPick(): Promise<PreviewPictureReferenceResult>;
  /** Captures the visible preview with annotation marker and target highlight overlays burned in. */
  captureAnnotationSnapshot(
    payload: PreviewAnnotationSnapshotRequest,
  ): Promise<PreviewPictureReferenceResult>;
  /**
   * Captures structured page context (v2) without a screenshot. Desktop only.
   */
  capturePageContext(): Promise<PreviewContextReferenceResult>;
  /** Deletes workspace-relative preview spill files after the message was sent or the queue dropped them. */
  releaseBrowserCaptureSpills(paths: readonly string[]): Promise<void>;
  /**
   * Single page-status channel for the active tab. The renderer holds one
   * {@link PreviewPageStatus} and derives loading/title/favicon from it.
   */
  onPageStatus(callback: (status: PreviewPageStatus) => void): () => void;
  /** Cancel any in-progress capture operation (region or element-pick). */
  cancelCapture(): Promise<void>;
  /**
   * Detected localhost ports for the empty-browser quick-open list. Optional:
   * the detection backend (#613) may not be present, in which case the empty
   * state shows no ports. Each call returns a fresh snapshot with current
   * online state.
   */
  detectLocalPorts?(): Promise<readonly DetectedLocalPort[]>;
  /** Multi-tab control surface (Phase A of the in-app browser rewrite). */
  tabs: PreviewTabsBridge;
  /** Live preview perf counters; dev HUD only. */
  getPerfCounters(): Promise<BrowserPerfCounters>;
  /** Phase D: adopt a renderer-hosted <webview>'s WebContents into the host bridge. */
  adoptWebview(payload: {
    webContentsId: number;
    threadId: string;
    tabId: string;
  }): Promise<{ ok: true } | { ok: false; error: string }>;
  releaseWebview(payload: {
    threadId: string;
    tabId: string;
  }): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Phase G: design-mode surface. */
  design: PreviewDesignBridge;
}

/** Built-in viewport presets exposed by Phase G. */
export type DesignViewportPresetId = "phone" | "tablet" | "desktop";

interface PreviewDesignBridge {
  setViewport(payload: {
    presetId?: DesignViewportPresetId;
    widthOverride?: number;
    heightOverride?: number;
  }): Promise<{ ok: true; data: { width: number; height: number } } | { ok: false; error: string }>;
  resetViewport(): Promise<{ ok: true } | { ok: false; error: string }>;
  setInspect(enabled: boolean): Promise<{ ok: true } | { ok: false; error: string }>;
  setAnnotationGuard(enabled: boolean): Promise<{ ok: true } | { ok: false; error: string }>;
}

/** Wire-side result of a tab IPC call. */
export type PreviewTabIpcResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: string };

/** Mutation result for create. */
export interface PreviewTabCreateData {
  readonly tabId: string;
  readonly tabs: BrowserTabSet;
}

/** Tab control surface mounted under `desktopBridge.preview.tabs`. */
interface PreviewTabsBridge {
  list(threadId: string): Promise<PreviewTabIpcResult<BrowserTabSet>>;
  create(threadId: string, activate?: boolean): Promise<PreviewTabIpcResult<PreviewTabCreateData>>;
  activate(threadId: string, tabId: string): Promise<PreviewTabIpcResult<BrowserTabSet>>;
  close(threadId: string, tabId: string): Promise<PreviewTabIpcResult<BrowserTabSet>>;
  closeScope(threadId: string): Promise<PreviewTabIpcResult<BrowserTabSet>>;
  /** Subscribe to push-style tab set updates emitted on navigation/favicon/close. */
  onUpdated(callback: (payload: BrowserTabSet) => void): () => void;
}

/** IPC push transport relayed from the Electron main process. */
interface IpcBridge {
  /** Register a callback for push messages forwarded by the main process. */
  onPush(callback: (data: unknown) => void): void;
  /** Register a callback for IPC connection close events. */
  onDisconnect(callback: () => void): void;
  /** Remove all IPC push listeners. */
  off(): void;
}

/** Data pushed from the main process when the user right-clicks in an editable area. */
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

/** Spellcheck IPC bridge for context menu and dictionary management. */
interface SpellcheckBridge {
  /** Listen for context-menu events. Returns the listener ref for targeted cleanup. */
  onContextMenu(callback: (data: SpellcheckContextMenuData) => void): (...args: unknown[]) => void;
  /** Remove a specific context-menu listener. */
  offContextMenu(listener: (...args: unknown[]) => void): void;
  /** Replace the misspelled word under the cursor with the given word. */
  replaceMisspelling(word: string): Promise<void>;
  /** Add a word to the user's custom dictionary. */
  addToDictionary(word: string): Promise<void>;
  /** Paste from clipboard via Electron's native webContents.paste(). */
  paste(): Promise<void>;
}

/**
 * Thin bridge exposed by the Electron preload script for native
 * desktop operations that cannot go through the WebSocket transport
 * (file dialogs, clipboard, editor launching, etc.).
 */
interface DesktopBridge {
  /** Return the URL and IPC path of the local mcode server. */
  getServerUrl(): Promise<{ url: string; ipcPath: string }>;
  /**
   * Verify the server is reachable; the main process silently restarts it if
   * not. Optional: older desktop builds may not expose it, so call sites use
   * optional chaining.
   */
  ensureServerRunning?(): Promise<void>;
  /**
   * Report whether this renderer considers the server busy (running turns or
   * terminals). While any renderer is busy the main process holds a power
   * save blocker so the OS does not suspend mid-turn. Optional: older desktop
   * builds may not expose it.
   */
  setServerBusy?(busy: boolean): Promise<void>;
  /** Open a native folder-picker dialog. Returns the selected path or null. */
  showOpenDialog(options: { title?: string }): Promise<string | null>;
  /** Open a URL in the default browser. */
  openExternalUrl(url: string, workspacePath?: string | null): Promise<void>;
  /** List openable apps (metadata + detection status) from the main-process registry. */
  listOpenInApps(): Promise<OpenInApp[]>;
  /**
   * Open a path in the app identified by `appId`. The main-process registry
   * dispatches to that app's adapter (editor launch or file-manager reveal), so
   * a single call handles both. Valid app IDs come from `listOpenInApps()`;
   * `line` is honored only by editor apps with a file target.
   */
  openIn(appId: string, path: string, line?: number): Promise<void>;
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
  /** Clear Blink's in-memory resource caches (images, scripts, CSS).
   * Typically called after a thread switch to reclaim memory. */
  clearRendererCache(): void;
  /** Return total bytes held in Blink's resource cache. */
  getRendererCacheBytes(): number;
  /** Open settings.json in the OS default editor. Resolves to an empty string on success. */
  openSettingsFile(): Promise<string>;
  /** Open keybindings.json in the OS default editor. Creates the file if it doesn't exist. */
  openKeybindingsFile(): Promise<string>;
  /** Spellcheck context menu and dictionary management. */
  spellcheck: SpellcheckBridge;
  /** App version and auto-update controls. */
  app: AppBridge;
  /** IPC push transport relayed from the main process. */
  ipc: IpcBridge;
  /** Embedded site preview (desktop only). */
  preview: PreviewBridge;
}

declare global {
  interface Window {
    desktopBridge?: DesktopBridge;
  }
}

export {};
