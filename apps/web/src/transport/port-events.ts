import { pushEmitter, suppressedPushChannels } from "./ws-transport";

/**
 * Receives push events from a MessagePort (via preload bridge)
 * and forwards them to the shared pushEmitter.
 *
 * When active, populates suppressedPushChannels in ws-transport
 * so WebSocket push skips channels handled by the port.
 */
export class PortEventSource {
  private active = false;
  private channels = new Set<string>();

  /** Whether the port source has received at least one event. */
  get isActive(): boolean {
    return this.active;
  }

  /** Channels currently handled by the port source. */
  get suppressedChannels(): ReadonlySet<string> {
    return this.channels;
  }

  /**
   * Return a callback suitable for registration via desktopBridge.onStreamEvent.
   * Each invocation receives one structured-clone message from the preload port.
   */
  getCallback(): (message: unknown) => void {
    return (message: unknown) => {
      if (!message || typeof message !== "object") return;

      const msg = message as { channel?: string; data?: unknown };
      if (!msg.channel) return;

      this.active = true;
      this.channels.add(msg.channel);
      suppressedPushChannels.add(msg.channel);
      pushEmitter.emit(msg.channel, msg.data);
    };
  }
}

/** Singleton port event source. */
export const portEventSource = new PortEventSource();
