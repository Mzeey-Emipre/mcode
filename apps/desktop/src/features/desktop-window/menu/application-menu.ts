import { BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";

import {
  sendDesktopRendererCommand,
  type DesktopRendererCommand,
  type RendererCommandWindowLookup,
} from "./renderer-commands.js";

/** Controlled Electron menu operations used by the application menu policy. */
export interface ApplicationMenuApi {
  /** Build a native menu from the supplied template. */
  buildFromTemplate(template: MenuItemConstructorOptions[]): unknown;
  /** Install or remove the native application menu. */
  setApplicationMenu(menu: unknown): void;
}

/** Dependencies for configuring the platform-specific application menu. */
export interface ApplicationMenuOptions {
  /** Return the current main window for renderer command fallback. */
  readonly getMainWindow: () => BrowserWindow | null;
  /** Override the platform in responsibility-local tests. */
  readonly platform?: NodeJS.Platform;
  /** Override Electron menu operations in responsibility-local tests. */
  readonly menu?: ApplicationMenuApi;
  /** Override focused-window resolution in responsibility-local tests. */
  readonly getFocusedWindow?: () => BrowserWindow | null;
}

const defaultMenuApi: ApplicationMenuApi = {
  buildFromTemplate: (template) => Menu.buildFromTemplate(template),
  setApplicationMenu: (menu) => Menu.setApplicationMenu(menu as Menu | null),
};

/** Configure macOS menus and remove the application menu on other platforms. */
export function configureApplicationMenu(options: ApplicationMenuOptions): void {
  const menuApi = options.menu ?? defaultMenuApi;
  if ((options.platform ?? process.platform) !== "darwin") {
    menuApi.setApplicationMenu(null);
    return;
  }

  const lookup: RendererCommandWindowLookup = {
    getFocusedWindow: options.getFocusedWindow ?? (() => BrowserWindow.getFocusedWindow()),
    getMainWindow: options.getMainWindow,
  };
  const sendCommand = (command: DesktopRendererCommand): void => {
    sendDesktopRendererCommand(command, lookup);
  };
  const template: MenuItemConstructorOptions[] = [
    { role: "appMenu" },
    {
      label: "File",
      submenu: [
        {
          label: "New Project",
          accelerator: "CmdOrCtrl+Shift+N",
          click: () => sendCommand("workspace.new"),
        },
        {
          label: "New Thread",
          accelerator: "CmdOrCtrl+N",
          click: () => sendCommand("thread.new"),
        },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        {
          label: "Toggle Sidebar",
          accelerator: "CmdOrCtrl+\\",
          click: () => sendCommand("sidebar.toggle"),
        },
        {
          label: "Toggle Right Panel",
          accelerator: "CmdOrCtrl+Alt+B",
          click: () => sendCommand("rightPanel.toggle"),
        },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          label: "Keyboard Shortcuts",
          click: () => sendCommand("settings.keyboard"),
        },
        {
          label: "About Mcode",
          click: () => sendCommand("settings.about"),
        },
      ],
    },
  ];

  menuApi.setApplicationMenu(menuApi.buildFromTemplate(template));
}
