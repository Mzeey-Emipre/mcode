import { describe, it, expect, beforeEach, vi } from "vitest";
import { getDefaultSettings } from "@mcode/contracts";
import { useSettingsStore } from "@/stores/settingsStore";

// Mock xterm.js to avoid DOM dependency
const mockTerminalInstance = {
  options: { scrollback: 0 },
  loadAddon: vi.fn(),
  open: vi.fn(),
  attachCustomKeyEventHandler: vi.fn(),
  getSelection: vi.fn(() => ""),
  onData: vi.fn(() => ({ dispose: vi.fn() })),
  write: vi.fn(),
  paste: vi.fn(),
  clear: vi.fn(),
  dispose: vi.fn(),
};

vi.mock("@xterm/xterm", () => ({
  Terminal: vi.fn(() => mockTerminalInstance),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn(() => ({
    fit: vi.fn(),
    proposeDimensions: vi.fn(() => ({ cols: 80, rows: 24 })),
  })),
}));

vi.mock("@/transport", () => ({
  getTransport: () => ({
    terminalWrite: vi.fn(() => Promise.resolve()),
    terminalResize: vi.fn(() => Promise.resolve()),
  }),
}));

describe("Terminal scrollback from settings", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      settings: getDefaultSettings(),
      loaded: true,
    });
  });

  it("default settings use 250 scrollback", () => {
    const settings = useSettingsStore.getState().settings;
    expect(settings.terminal.scrollback).toBe(250);
  });

  it("settings store accepts custom scrollback value", () => {
    useSettingsStore.setState({
      settings: {
        ...getDefaultSettings(),
        terminal: { scrollback: 1000 },
      },
    });
    expect(useSettingsStore.getState().settings.terminal.scrollback).toBe(1000);
  });
});
