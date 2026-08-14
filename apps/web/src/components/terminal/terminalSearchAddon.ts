/** Loads the terminal SearchAddon at the renderer boundary. */
export function loadTerminalSearchAddon(): Promise<typeof import("@xterm/addon-search")> {
  return import("@xterm/addon-search");
}
