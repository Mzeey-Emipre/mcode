import { describe, expect, it, vi } from "vitest";

const applicationMenuTest = vi.hoisted(() => ({
  BrowserWindow: { getFocusedWindow: vi.fn(() => null) },
  Menu: {
    buildFromTemplate: vi.fn(),
    setApplicationMenu: vi.fn(),
  },
}));

vi.mock("electron", () => applicationMenuTest);

import {
  configureApplicationMenu,
  type ApplicationMenuApi,
} from "../application-menu.js";

type MenuEntry = {
  readonly label?: string;
  readonly role?: string;
  readonly type?: string;
  readonly accelerator?: string;
  readonly submenu?: readonly MenuEntry[];
  readonly click?: () => void;
};

function menuFixture() {
  let focusedWindow: { isDestroyed(): boolean; webContents: { send: ReturnType<typeof vi.fn> } } | null = null;
  const mainWindow = {
    isDestroyed: vi.fn(() => false),
    webContents: { send: vi.fn() },
  };
  const menuApi: ApplicationMenuApi = {
    buildFromTemplate: vi.fn((template) => template),
    setApplicationMenu: vi.fn(),
  };
  const configure = (platform: NodeJS.Platform) => {
    configureApplicationMenu({
      platform,
      getMainWindow: () => mainWindow as never,
      getFocusedWindow: () => focusedWindow as never,
      menu: menuApi,
    });
  };
  return {
    mainWindow,
    menuApi,
    configure,
    setFocusedWindow: (window: typeof focusedWindow) => {
      focusedWindow = window;
    },
  };
}

function submenu(template: readonly MenuEntry[], label: string): readonly MenuEntry[] {
  return template.find((entry) => entry.label === label)?.submenu ?? [];
}

describe("Desktop Window application menu", () => {
  it("builds the macOS menu with existing roles, labels, accelerators, and commands", () => {
    const fixture = menuFixture();
    fixture.configure("darwin");

    const template = fixture.menuApi.buildFromTemplate.mock.calls[0][0] as unknown as readonly MenuEntry[];
    expect(template.map(({ label, role }) => ({ label, role }))).toEqual([
      { label: undefined, role: "appMenu" },
      { label: "File", role: undefined },
      { label: undefined, role: "editMenu" },
      { label: "View", role: undefined },
      { label: undefined, role: "windowMenu" },
      { label: undefined, role: "help" },
    ]);

    expect(submenu(template, "File")).toEqual(
      expect.arrayContaining([
        { label: "New Project", accelerator: "CmdOrCtrl+Shift+N", click: expect.any(Function) },
        { label: "New Thread", accelerator: "CmdOrCtrl+N", click: expect.any(Function) },
        { type: "separator" },
        { role: "close" },
      ]),
    );
    expect(submenu(template, "View")).toEqual(
      expect.arrayContaining([
        { label: "Toggle Sidebar", accelerator: "CmdOrCtrl+\\", click: expect.any(Function) },
        { label: "Toggle Right Panel", accelerator: "CmdOrCtrl+Alt+B", click: expect.any(Function) },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { role: "togglefullscreen" },
      ]),
    );
    expect(submenu(template, "")).toEqual([]);
    expect(template.find((entry) => entry.role === "help")?.submenu).toEqual([
      { label: "Keyboard Shortcuts", click: expect.any(Function) },
      { label: "About Mcode", click: expect.any(Function) },
    ]);
  });

  it("routes commands to the focused window, then falls back to the main window", () => {
    const fixture = menuFixture();
    const focusedWindow = {
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() },
    };
    fixture.setFocusedWindow(focusedWindow);
    fixture.configure("darwin");
    const template = fixture.menuApi.buildFromTemplate.mock.calls[0][0] as unknown as readonly MenuEntry[];
    const fileMenu = submenu(template, "File");
    const newThread = fileMenu.find((entry) => entry.label === "New Thread")?.click;
    const newProject = fileMenu.find((entry) => entry.label === "New Project")?.click;

    newThread?.();
    expect(focusedWindow.webContents.send).toHaveBeenCalledWith(
      "desktop:command",
      "thread.new",
    );

    fixture.setFocusedWindow(null);
    newProject?.();
    expect(fixture.mainWindow.webContents.send).toHaveBeenCalledWith(
      "desktop:command",
      "workspace.new",
    );
  });

  it("does not send commands to a destroyed focused window", () => {
    const fixture = menuFixture();
    const focusedWindow = {
      isDestroyed: vi.fn(() => true),
      webContents: { send: vi.fn() },
    };
    fixture.setFocusedWindow(focusedWindow);
    fixture.configure("darwin");
    const template = fixture.menuApi.buildFromTemplate.mock.calls[0][0] as unknown as readonly MenuEntry[];
    const viewMenu = submenu(template, "View");
    viewMenu.find((entry) => entry.label === "Toggle Sidebar")?.click?.();

    expect(focusedWindow.webContents.send).not.toHaveBeenCalled();
    expect(fixture.mainWindow.webContents.send).not.toHaveBeenCalled();
  });

  it("removes the application menu on non-macOS platforms", () => {
    const fixture = menuFixture();

    fixture.configure("win32");

    expect(fixture.menuApi.buildFromTemplate).not.toHaveBeenCalled();
    expect(fixture.menuApi.setApplicationMenu).toHaveBeenCalledWith(null);
  });
});
