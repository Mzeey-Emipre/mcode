import { pushEmitter, suppressedPushChannels } from "./ws-transport";

/**
 * IPC push client that listens for messages relayed by the Electron main
 * process. The main process owns the net.Socket to the server's IPC endpoint
 * and forwards parsed frames via webContents.send / ipcRenderer.on.
 * Populates suppressedPushChannels to prevent WebSocket duplicates.
 */
export class IpcPushClient {
  private _active = false;
  private channels = new Set<string>();

  /** Whether the IPC connection is active. */
  get isActive(): boolean {
    return this._active;
  }

  /**
   * Start listening for IPC push events from the main process.
   * No-op if desktopBridge is not available (browser mode).
   */
  /** Start listening. The ipcPath is unused here - the main process owns the connection. */
  connect(): void {
    if (!window.desktopBridge?.ipc) return;

    this.disconnect();

    window.desktopBridge.ipc.onPush((data) => {
      if (!data || typeof data !== "object") return;
      const msg = data as { channel?: string; data?: unknown };
      if (!msg.channel) return;

      this.channels.add(msg.channel);
      suppressedPushChannels.add(msg.channel);
      pushEmitter.emit(msg.channel, msg.data);
    });

    window.desktopBridge.ipc.onDisconnect(() => {
      this.clearSuppressed();
      this._active = false;
    });

    this._active = true;
  }

  /** Stop listening and clear suppressed channels (WebSocket takes over). */
  disconnect(): void {
    window.desktopBridge?.ipc?.off();
    this.clearSuppressed();
    this._active = false;
  }

  private clearSuppressed(): void {
    for (const ch of this.channels) {
      suppressedPushChannels.delete(ch);
    }
    this.channels.clear();
  }
}

/** Singleton IPC push client. */
export const ipcPushClient = new IpcPushClient();
