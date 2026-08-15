import { BrowserWindow, type BrowserWindow as BrowserWindowType } from "electron";

import {
  attachCloseGuard,
  type CloseGuardDependencies,
} from "./lifecycle/close-guard.js";
import {
  createWindow,
  type DesktopWindowLifecycleHooks,
} from "./lifecycle/create-window.js";
import { configureApplicationMenu } from "./menu/application-menu.js";
import { registerDesktopWindowActionHandler } from "./actions/handlers.js";
import { installMainWindowNavigationPolicy } from "./navigation/main-window-policy.js";

/** Dependencies for the Desktop Window feature entry point. */
export interface DesktopWindowFeatureDependencies {
  /** Return whether the desktop runs in development mode. */
  readonly isDesktopDev: () => boolean;
  /** Per-window Preview, Spellcheck, and Server Runtime operations. */
  readonly lifecycleHooks: DesktopWindowLifecycleHooks;
  /** Active-agent close confirmation dependencies. */
  readonly closeGuard: CloseGuardDependencies;
}

/** The public operations provided by the Desktop Window feature. */
export interface DesktopWindowFeature {
  /** Return the current main window, if one exists. */
  readonly getMainWindow: () => BrowserWindowType | null;
  /** Create and install one main window. */
  readonly createWindow: () => BrowserWindowType;
  /** Recreate the main window only when no window exists. */
  readonly recreateWindowIfNeeded: () => BrowserWindowType | null;
}

/** Return the icon path owned by the Desktop Window feature. */
export { getWindowIconPath } from "./lifecycle/icon-path.js";

/** Create the Desktop Window feature and register its native capabilities. */
export function createDesktopWindowFeature(
  dependencies: DesktopWindowFeatureDependencies,
): DesktopWindowFeature {
  let mainWindow: BrowserWindowType | null = null;

  configureApplicationMenu({ getMainWindow: () => mainWindow });
  registerDesktopWindowActionHandler();

  const create = (): BrowserWindowType => {
    const window = createWindow({
      isDesktopDev: dependencies.isDesktopDev,
      hooks: dependencies.lifecycleHooks,
    });
    installMainWindowNavigationPolicy(window);
    attachCloseGuard(window, dependencies.closeGuard);
    mainWindow = window;
    return window;
  };

  return {
    getMainWindow: () => mainWindow,
    createWindow: create,
    recreateWindowIfNeeded: () => {
      if (BrowserWindow.getAllWindows().length > 0) return null;
      return create();
    },
  };
}

export {
  openExternalUrl,
  registerExternalUrlHandler,
} from "./navigation/external-url.js";
export type {
  WorkspacePreviewUrlResolution,
  WorkspacePreviewUrlResolver,
} from "./navigation/external-url.js";
export { installMainWindowNavigationPolicy } from "./navigation/main-window-policy.js";
export {
  DESKTOP_WINDOW_ACTIONS,
  performDesktopWindowAction,
} from "./actions/window-actions.js";
export type { DesktopWindowAction } from "./actions/window-actions.js";
export { registerDesktopWindowActionHandler } from "./actions/handlers.js";
export { configureApplicationMenu } from "./menu/application-menu.js";
export type {
  ApplicationMenuApi,
  ApplicationMenuOptions,
} from "./menu/application-menu.js";
export { sendDesktopRendererCommand } from "./menu/renderer-commands.js";
export type {
  DesktopRendererCommand,
  RendererCommandWindowLookup,
} from "./menu/renderer-commands.js";
export type {
  CloseGuardDependencies,
  CloseGuardMessageBoxOptions,
} from "./lifecycle/close-guard.js";
export { attachCloseGuard } from "./lifecycle/close-guard.js";
export { createWindow } from "./lifecycle/create-window.js";
export type {
  CreateWindowDependencies,
  DesktopWindowLifecycleHooks,
} from "./lifecycle/create-window.js";
