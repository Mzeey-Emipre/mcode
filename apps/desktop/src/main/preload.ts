/**
 * Electron preload script.
 * Exposes the `desktopBridge` API to the renderer via contextBridge,
 * providing access to native OS features (dialogs, clipboard, editors)
 * and the server connection URL.
 */

import { contextBridge, ipcRenderer, webFrame, webUtils } from "electron";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  PREVIEW_POPUP_REQUESTED_CHANNEL,
  type PreviewPopupRequest,
} from "../features/preview/contracts/popup.js";
import {
  PREVIEW_SURFACE_DISCARD_REQUESTED_CHANNEL,
  type PreviewSurfaceDiscardRequest,
} from "../features/preview/contracts/surface-lifecycle.js";

contextBridge.exposeInMainWorld("desktopBridge", {
  ...(process.env.MCODE_TERMINAL_RELEASE_TEST === "1" &&
  !process.env.ELECTRON_RENDERER_URL &&
  existsSync(resolve(process.resourcesPath, "app.asar"))
    ? { terminalReleaseTest: { enabled: true as const } }
    : {}),
  /** Platform facts and allowlisted native window actions for the custom title bar. */
  window: {
    platform: process.platform,
    isDevelopment: Boolean(process.env.ELECTRON_RENDERER_URL),
    onCommand(callback: (command: string) => void) {
      const listener = (_event: unknown, command: string) => callback(command);
      ipcRenderer.on("desktop:command", listener);
      return listener;
    },
    offCommand(listener: (...args: unknown[]) => void): void {
      ipcRenderer.removeListener("desktop:command", listener);
    },
    perform(action: string): Promise<void> {
      return ipcRenderer.invoke("window:perform", action);
    },
  },
  /** Get the WebSocket URL (with auth token) and IPC path for connecting to the server. */
  getServerUrl: (): Promise<{ url: string; ipcPath: string }> =>
    ipcRenderer.invoke("get-server-url"),

  /** Verify the server is reachable; the main process silently restarts it if not. */
  ensureServerRunning: (): Promise<void> =>
    ipcRenderer.invoke("ensure-server-running"),

  /** Report whether this renderer considers the server busy (running turns / terminals).
   * While any renderer is busy, the main process holds a power save blocker. */
  setServerBusy: (busy: boolean): Promise<void> =>
    ipcRenderer.invoke("set-server-busy", busy),

  /** Query the main process for Electron's assistive-technology support signal. */
  getAccessibilitySupport: (): Promise<boolean> =>
    ipcRenderer.invoke("accessibility:get-support"),

  /** Electron process data exposed only when the performance runner starts the app. */
  performance: {
    getMetrics: (): Promise<unknown> =>
      ipcRenderer.invoke("performance:get-app-metrics"),
    quit: (): Promise<void> => ipcRenderer.invoke("performance:quit"),
  },

  /** Show a native open-directory dialog. Returns the selected path or null. */
  showOpenDialog: (opts: Record<string, unknown>): Promise<string | null> =>
    ipcRenderer.invoke("show-open-dialog", opts),

  /** Open a URL in the default browser (https, http, mailto, or resolved mcode-workspace file targets). */
  openExternalUrl: (
    url: string,
    workspacePath?: string | null,
  ): Promise<void> =>
    ipcRenderer.invoke("open-external-url", url, workspacePath ?? null),

  /** List openable apps (metadata + detection status) from the main-process registry. */
  listOpenInApps: (): Promise<unknown> =>
    ipcRenderer.invoke("list-open-in-apps"),

  /**
   * Open a path in the given registry app. The main-process registry dispatches
   * to the matching adapter, so a single call opens an editor or reveals a path
   * in the file manager. `line` jumps an editor to that line for file targets;
   * other apps ignore it.
   */
  openIn: (appId: string, path: string, line?: number): Promise<void> =>
    ipcRenderer.invoke("open-in", appId, path, line),

  /** Read an image from the clipboard and save it as a temp JPEG. */
  readClipboardImage: (): Promise<unknown> =>
    ipcRenderer.invoke("read-clipboard-image"),

  /** Save a file blob from the clipboard to a temp location. */
  saveClipboardFile: (
    buffer: Uint8Array,
    mimeType: string,
    fileName: string,
  ): Promise<unknown> =>
    ipcRenderer.invoke("save-clipboard-file", buffer, mimeType, fileName),

  /** Get the absolute path to the log directory. */
  getLogPath: (): Promise<string> => ipcRenderer.invoke("get-log-path"),

  /** Read the last N lines from the most recent log file. */
  getRecentLogs: (lines: number): Promise<string> =>
    ipcRenderer.invoke("get-recent-logs", lines),

  /** Report safe renderer crash diagnostics to the local desktop logger. */
  reportRendererCrash: (payload: {
    errorName: string;
    componentStack: string;
  }): Promise<void> => ipcRenderer.invoke("renderer:crash-report", payload),

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
      images.size +
      scripts.size +
      cssStyleSheets.size +
      xslStyleSheets.size +
      fonts.size +
      other.size
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
   * Embedded thread Preview bridge. No-op channels in web builds
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
    resolveNavigation(
      url: string,
      workspacePath?: string | null,
    ): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
      return ipcRenderer.invoke(
        "preview:resolve-navigation",
        url,
        workspacePath ?? null,
      );
    },
    navigate(
      url: string,
      workspacePath?: string | null,
    ): Promise<{ ok: true } | { ok: false; error: string }> {
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
    /** Hard reload that bypasses the guest's HTTP cache (Force reload). */
    forceReload(): Promise<void> {
      return ipcRenderer.invoke("preview:force-reload");
    },
    /** Clear the preview session's cookies. */
    clearCookies(): Promise<void> {
      return ipcRenderer.invoke("preview:clear-cookies");
    },
    /** Clear the preview session's HTTP cache. */
    clearCache(): Promise<void> {
      return ipcRenderer.invoke("preview:clear-cache");
    },
    /** Read the guest's current zoom factor (1 = 100%). */
    getZoom(): Promise<number> {
      return ipcRenderer.invoke("preview:get-zoom");
    },
    /** Set the guest's zoom factor; returns the clamped factor actually applied. */
    setZoom(factor: number): Promise<number> {
      return ipcRenderer.invoke("preview:set-zoom", factor);
    },
    openExternal(): Promise<void> {
      return ipcRenderer.invoke("preview:open-external");
    },
    openGuestDevTools(target?: { readonly threadId: string; readonly tabId: string }): Promise<void> {
      return ipcRenderer.invoke("preview:open-guest-devtools", target);
    },
    getNavigationState(): Promise<{
      canGoBack: boolean;
      canGoForward: boolean;
    }> {
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
    /** Capture the visible preview with annotation marker and target highlight context. */
    captureAnnotationSnapshot(payload: unknown): Promise<unknown> {
      return ipcRenderer.invoke("preview:capture-annotation-snapshot", payload);
    },
    /** Structured page context for the composer fence without capturing a PNG. */
    capturePageContext(): Promise<unknown> {
      return ipcRenderer.invoke("preview:capture-context-reference");
    },
    releaseBrowserCaptureSpills(paths: readonly string[]): Promise<void> {
      return ipcRenderer.invoke("preview:release-browser-capture-spill", [
        ...paths,
      ]);
    },
    /**
     * Subscribe to the single page-status channel: the full PreviewPageStatus
     * (url, title, favicon, phase, error?) emitted once per change for the
     * active tab. Replaces the old loading-state / did-navigate /
     * did-update-favicon trio.
     */
    onPageStatus(
      callback: (status: import("@mcode/contracts").PreviewPageStatus) => void,
    ) {
      const listener = (
        _event: unknown,
        status: import("@mcode/contracts").PreviewPageStatus,
      ) => callback(status);
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
      return () =>
        ipcRenderer.removeListener("preview:shortcut-fired", listener);
    },
    /** Read the live perf counter bag (dev HUD only). */
    getPerfCounters(): Promise<unknown> {
      return ipcRenderer.invoke("preview:get-perf-counters");
    },
    /** Typed generation-bound Electron surface operations. */
    surface: {
      prepare(payload: {
        surface: {
          identity: {
            workspaceId: string;
            scope: { kind: "thread" | "workspace"; id: string };
            tabId: string;
          };
          generation: number;
        };
        adoptionToken: string;
      }): Promise<{ ok: true } | { ok: false; error: string }> {
        return ipcRenderer.invoke("preview.surface.prepare", payload);
      },
      adopt(payload: {
        surface: {
          identity: {
            workspaceId: string;
            scope: { kind: "thread" | "workspace"; id: string };
            tabId: string;
          };
          generation: number;
        };
        adoptionToken: string;
      }): Promise<{ ok: true } | { ok: false; error: string }> {
        return ipcRenderer.invoke("preview.surface.adopt", payload);
      },
      release(payload: {
        surface: {
          identity: {
            workspaceId: string;
            scope: { kind: "thread" | "workspace"; id: string };
            tabId: string;
          };
          generation: number;
        };
        reason: "discard" | "replace" | "dispose" | "loss";
      }): Promise<{ ok: true } | { ok: false; error: string }> {
        return ipcRenderer.invoke("preview.surface.release", payload);
      },
      navigate(payload: {
        surface: {
          identity: {
            workspaceId: string;
            scope: { kind: "thread" | "workspace"; id: string };
            tabId: string;
          };
          generation: number;
        };
        navigation:
          | { kind: "initial"; address?: string }
          | { kind: "restored" | "address"; address: string }
          | { kind: "back" | "forward" | "reload" | "force-reload" };
      }): Promise<{ ok: true } | { ok: false; error: string }> {
        return ipcRenderer.invoke("preview.surface.navigate", payload);
      },
      /** Subscribes to opener-free popup requests for exact adopted surfaces. */
      onPopupRequested(callback: (request: PreviewPopupRequest) => void): () => void {
        const listener = (_event: unknown, request: PreviewPopupRequest) => callback(request);
        ipcRenderer.on(PREVIEW_POPUP_REQUESTED_CHANNEL, listener);
        return () => ipcRenderer.removeListener(PREVIEW_POPUP_REQUESTED_CHANNEL, listener);
      },
      /** Subscribes to exact-generation Memory Saver discard requests. */
      onDiscardRequested(callback: (request: PreviewSurfaceDiscardRequest) => void): () => void {
        const listener = (_event: unknown, request: PreviewSurfaceDiscardRequest) => callback(request);
        ipcRenderer.on(PREVIEW_SURFACE_DISCARD_REQUESTED_CHANNEL, listener);
        return () => ipcRenderer.removeListener(PREVIEW_SURFACE_DISCARD_REQUESTED_CHANNEL, listener);
      },
    },
    /** Bounded provider-neutral browser operations. Raw CDP is intentionally not exposed. */
    automation: {
      execute(payload: unknown): Promise<unknown> {
        return ipcRenderer.invoke("preview:automation.execute", payload);
      },
      beginRendererOperation(payload: unknown): Promise<unknown> {
        return ipcRenderer.invoke("preview:automation.begin-renderer-operation", payload);
      },
      finishRendererOperation(payload: { leaseId: string; succeeded: boolean }): Promise<boolean> {
        return ipcRenderer.invoke("preview:automation.finish-renderer-operation", payload);
      },
      cancel(requestId: string): Promise<boolean> {
        return ipcRenderer.invoke("preview:automation.cancel", requestId);
      },
      interrupt(target: { threadId: string; tabId: string }): Promise<boolean> {
        return ipcRenderer.invoke("preview:automation.interrupt", target);
      },
      releaseAgentControl(target: {
        threadId: string;
        tabId: string;
        controlEpoch: number;
        providerSessionId: string;
      }): Promise<boolean> {
        return ipcRenderer.invoke("preview:automation.release-agent-control", target);
      },
      describeTarget(target: { threadId: string; tabId: string }): Promise<unknown> {
        return ipcRenderer.invoke("preview:automation.describe-target", target);
      },
      getMediaSourceId(target: {
        windowId: number;
        threadId: string;
        tabId: string;
        targetGeneration: number;
      }): Promise<unknown> {
        return ipcRenderer.invoke("preview:automation.media-source", target);
      },
      onControllerChanged(callback: (state: unknown) => void): () => void {
        const listener = (_event: unknown, state: unknown) => callback(state);
        ipcRenderer.send("preview:automation.subscribe");
        ipcRenderer.on("preview:automation.controller", listener);
        return () => ipcRenderer.removeListener("preview:automation.controller", listener);
      },
    },
    /** Design mode operations applied to the adopted Browser guest. */
    design: {
      setInspect(enabled: boolean): Promise<unknown> {
        return ipcRenderer.invoke("preview:design.set-inspect", { enabled });
      },
      setAnnotationGuard(enabled: boolean): Promise<unknown> {
        return ipcRenderer.invoke("preview:design.set-annotation-guard", {
          enabled,
        });
      },
    },
    /** Multi-tab control surface for BrowserSurfaceHost-owned pages. */
    tabs: {
      list(threadId: string, workspaceId?: string): Promise<unknown> {
        return ipcRenderer.invoke("preview:tabs.list", { threadId, workspaceId });
      },
      open(
        threadId: string,
        workspaceId: string,
        options?: {
          activate?: boolean;
          tabId?: string;
          initialAddress?: string;
        },
      ): Promise<unknown> {
        return ipcRenderer.invoke("preview:tabs.open", {
          threadId,
          workspaceId,
          activate: options?.activate,
          tabId: options?.tabId,
          initialAddress: options?.initialAddress,
        });
      },
      activate(threadId: string, workspaceId: string, tabId: string): Promise<unknown> {
        return ipcRenderer.invoke("preview:tabs.activate", { threadId, workspaceId, tabId });
      },
      updateChrome(
        threadId: string,
        workspaceId: string,
        tabId: string,
        chrome: { title: string | null; url: string | null; faviconUrl: string | null },
      ): Promise<unknown> {
        return ipcRenderer.invoke("preview:tabs.updateChrome", {
          threadId,
          workspaceId,
          tabId,
          ...chrome,
        });
      },
      close(threadId: string, workspaceId: string, tabId: string): Promise<unknown> {
        return ipcRenderer.invoke("preview:tabs.close", { threadId, workspaceId, tabId });
      },
      closeScope(threadId: string, workspaceId: string): Promise<unknown> {
        return ipcRenderer.invoke("preview:tabs.closeScope", { threadId, workspaceId });
      },
      onUpdated(callback: (payload: unknown) => void): () => void {
        const listener = (_event: unknown, payload: unknown) =>
          callback(payload);
        ipcRenderer.on("preview:tabs-updated", listener);
        return () =>
          ipcRenderer.removeListener("preview:tabs-updated", listener);
      },
    },
  },

  /** IPC push transport relayed from the main process. */
  ipc: {
    /** Listen for push messages forwarded by the main process IPC relay. */
    onPush(callback: (data: unknown) => void) {
      ipcRenderer.on("ipc-push-message", (_event: unknown, data: unknown) =>
        callback(data),
      );
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
