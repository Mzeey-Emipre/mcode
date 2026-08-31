import { BrowserWindow } from "electron";
import * as NodePath from "node:path";

import type {
  PreviewWebviewAttachParams,
  PreviewWebviewPreferences,
} from "../../preview/index.js";
import { getWindowIconPath } from "./icon-path.js";

/** Per-window Preview, Spellcheck, and Server Runtime operations. */
export interface DesktopWindowLifecycleHooks {
  /** Dispose Preview state for a closing window. */
  readonly disposePreviewForWindow: (window: BrowserWindow) => void;
  /** Dispose Browser Automation state for a closing window. */
  readonly disposeBrowserAutomationForWindow: (windowId: number) => void;
  /** Harden a newly attached Preview webview. */
  readonly hardenPreviewWebviewAttachment: (
    webPreferences: PreviewWebviewPreferences,
    params: PreviewWebviewAttachParams,
    guestPreloadPath: string,
  ) => void;
  /** Resolve the fixed Preview guest preload path. */
  readonly resolvePreviewGuestPreloadPath: (mainBundleDirectory: string) => string;
  /** Attach Spellcheck to a created window. */
  readonly setupSpellcheck: (window: BrowserWindow) => void;
  /** Attach Server Runtime transport to a created window. */
  readonly attachServerWindow: (window: BrowserWindow) => void;
}

/** Dependencies for creating one behavior-preserving desktop window. */
export interface CreateWindowDependencies {
  /** Platform selected by the Electron composition root. */
  readonly platform: NodeJS.Platform;
  /** Return whether the desktop runs in development mode. */
  readonly isDesktopDev: () => boolean;
  /** Per-window feature hooks. */
  readonly hooks: DesktopWindowLifecycleHooks;
}

/** Create and wire one main BrowserWindow. */
export function createWindow(
  dependencies: CreateWindowDependencies,
): BrowserWindow {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: getWindowIconPath(dependencies.platform),
    // Keep window hidden until first paint to eliminate the blank white flash.
    show: false,
    backgroundColor: "#0a0a0f",
    autoHideMenuBar: true,
    ...(dependencies.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 14, y: 12 },
        }
      : {
          titleBarStyle: "hidden" as const,
          titleBarOverlay: {
            color: "#00000000",
            symbolColor: "#8a8a92",
            height: 40,
          },
        }),
    webPreferences: {
      preload: NodePath.join(__dirname, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // Documented explicitly; defaults to true in Electron but we set it
      // here for clarity. The load-bearing call is setSpellCheckerLanguages().
      spellcheck: true,
      // Phase D of the in-app browser rewrite: enable <webview> so the
      // renderer can host a guest WebContents whose id is later adopted by
      // the Browser automation host. webview-tag carries Chromium guest
      // process risks; the will-attach-webview hook below clamps webPreferences
      // and we never expose nodeIntegrationInSubFrames.
      webviewTag: true,
      // Chromium DevTools only in `bun run dev:desktop` (ELECTRON_RENDERER_URL).
      // Packaged releases and local `bun run prod` keep DevTools disabled.
      devTools: dependencies.isDesktopDev(),
    },
  });

  window.setMenuBarVisibility(false);

  window.once("closed", () => {
    dependencies.hooks.disposePreviewForWindow(window);
    dependencies.hooks.disposeBrowserAutomationForWindow(window.id);
  });

  window.webContents.on("will-attach-webview", (_event, webPreferences, params) => {
    dependencies.hooks.hardenPreviewWebviewAttachment(
      webPreferences,
      params,
      dependencies.hooks.resolvePreviewGuestPreloadPath(__dirname),
    );
  });

  const showFallback = setTimeout(() => {
    if (!window.isDestroyed()) window.show();
  }, 3000);
  window.once("ready-to-show", () => {
    clearTimeout(showFallback);
    window.show();
  });
  window.once("closed", () => clearTimeout(showFallback));

  if (process.env.ELECTRON_RENDERER_URL) {
    window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    window.loadFile(NodePath.join(__dirname, "../renderer/index.html"));
  }

  if (dependencies.isDesktopDev()) {
    window.webContents.once("did-finish-load", () => {
      if (!window.isDestroyed()) {
        window.webContents.openDevTools({ mode: "right" });
      }
    });
  }

  dependencies.hooks.setupSpellcheck(window);
  dependencies.hooks.attachServerWindow(window);

  return window;
}
