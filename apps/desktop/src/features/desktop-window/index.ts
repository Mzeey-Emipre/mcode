/** Public surface of the Desktop Window feature. */

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
