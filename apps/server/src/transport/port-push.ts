/**
 * Port-based push transport for streaming events.
 * Sends events via MessagePort using structured clone (no JSON serialization).
 * Used when the server runs as an Electron utilityProcess with a transferred port.
 */
export class PortPush {
  private port: MessagePortLike | null = null;

  /** Whether a port is currently attached and ready to send. */
  get isActive(): boolean {
    return this.port !== null;
  }

  /** Attach a MessagePort for sending push events. */
  attach(port: MessagePortLike): void {
    this.port = port;
  }

  /** Detach and close the current port. */
  detach(): void {
    if (this.port) {
      this.port.close();
      this.port = null;
    }
  }

  /** Send a push event through the port. No-op if no port is attached. */
  send(channel: string, data: unknown): void {
    if (!this.port) return;
    try {
      this.port.postMessage({ channel, data });
    } catch {
      // Port may have been closed; detach silently.
      // WebSocket fallback will deliver the event.
      this.port = null;
    }
  }
}

/** Minimal interface matching both Node MessagePort and Electron MessagePortMain. */
export interface MessagePortLike {
  /** Post a message through the port. */
  postMessage(message: unknown): void;
  /** Close the port. */
  close(): void;
  /** Register an event listener on the port. */
  on(event: string, listener: (...args: unknown[]) => void): void;
}
