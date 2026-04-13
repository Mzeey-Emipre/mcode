import { pushEmitter, suppressedPushChannels } from "./ws-transport";

/**
 * IPC push client that connects via the preload bridge's ipc.connect().
 * Receives length-prefixed push frames and forwards to pushEmitter.
 * Populates suppressedPushChannels to prevent WebSocket duplicates.
 */
export class IpcPushClient {
  private handle: ReturnType<NonNullable<typeof window.desktopBridge>["ipc"]["connect"]> | null = null;
  private channels = new Set<string>();

  /** Whether the IPC connection is active. */
  get isActive(): boolean {
    return this.handle !== null;
  }

  /**
   * Connect to the server's IPC push endpoint.
   * No-op if desktopBridge is not available (browser mode).
   */
  connect(ipcPath: string): void {
    if (!window.desktopBridge?.ipc) return;

    this.disconnect();

    this.handle = window.desktopBridge.ipc.connect(ipcPath);

    this.handle.onMessage((data) => {
      if (!data || typeof data !== "object") return;
      const msg = data as { channel?: string; data?: unknown };
      if (!msg.channel) return;

      this.channels.add(msg.channel);
      suppressedPushChannels.add(msg.channel);
      pushEmitter.emit(msg.channel, msg.data);
    });

    this.handle.onDisconnect(() => {
      this.clearSuppressed();
      this.handle = null;
    });
  }

  /** Disconnect and clear suppressed channels (WebSocket takes over). */
  disconnect(): void {
    this.handle?.close();
    this.clearSuppressed();
    this.handle = null;
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
