import type { McodeTransport } from "./types";
import { createTauriTransport, isTauri } from "./tauri";

export type { McodeTransport, Workspace, Thread, Message } from "./types";

let transport: McodeTransport | null = null;

export function getTransport(): McodeTransport {
  if (!transport) {
    if (isTauri()) {
      transport = createTauriTransport();
    } else {
      // Future: createWebSocketTransport() for web version
      throw new Error(
        "No transport available. Running outside Tauri without a web server."
      );
    }
  }
  return transport;
}
