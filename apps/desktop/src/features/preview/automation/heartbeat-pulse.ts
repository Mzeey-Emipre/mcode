/** IPC channel used to subscribe a renderer to Browser host heartbeat pulses. */
export const BROWSER_AUTOMATION_HEARTBEAT_SUBSCRIBE_CHANNEL =
  "preview:automation.heartbeat.subscribe";

/** IPC channel used to deliver Browser host heartbeat pulses. */
export const BROWSER_AUTOMATION_HEARTBEAT_CHANNEL = "preview:automation.heartbeat";

/** Interval for the Electron main Browser host heartbeat clock. */
export const BROWSER_AUTOMATION_HEARTBEAT_INTERVAL_MS = 10_000;

interface BrowserAutomationHeartbeatSender {
  isDestroyed(): boolean;
  send(channel: string): void;
  once(event: "destroyed", callback: () => void): void;
}

/** Pulses subscribed renderers from Electron main, outside Chromium timer throttling. */
export class BrowserAutomationHeartbeatPulse {
  private readonly subscribers = new Set<BrowserAutomationHeartbeatSender>();
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Adds one renderer and sends its first pulse immediately. */
  subscribe(sender: BrowserAutomationHeartbeatSender): void {
    if (sender.isDestroyed() || this.subscribers.has(sender)) return;
    this.subscribers.add(sender);
    sender.once("destroyed", () => this.remove(sender));
    sender.send(BROWSER_AUTOMATION_HEARTBEAT_CHANNEL);
    if (this.timer === null) {
      this.timer = setInterval(() => this.pulse(), BROWSER_AUTOMATION_HEARTBEAT_INTERVAL_MS);
    }
  }

  private pulse(): void {
    for (const sender of this.subscribers) {
      if (sender.isDestroyed()) {
        this.remove(sender);
      } else {
        sender.send(BROWSER_AUTOMATION_HEARTBEAT_CHANNEL);
      }
    }
  }

  private remove(sender: BrowserAutomationHeartbeatSender): void {
    this.subscribers.delete(sender);
    if (this.subscribers.size === 0 && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
