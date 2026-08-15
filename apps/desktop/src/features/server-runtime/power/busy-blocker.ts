/** Sender boundary required by {@link BusyBlocker}. */
export interface ServerBusySender {
  /** Stable Electron WebContents id. */
  readonly id: number;
  /** Register cleanup when the sender is destroyed. */
  once: (event: "destroyed", listener: () => void) => void;
}

/** Power-management boundary required by {@link BusyBlocker}. */
export interface ServerPowerSaveBlocker {
  /** Start preventing application suspension. */
  start: (reason: "prevent-app-suspension") => number;
  /** Stop a previously started blocker. */
  stop: (id: number) => void;
}

/** Dependencies required by {@link BusyBlocker}. */
export interface BusyBlockerDeps {
  /** Electron power-save blocker boundary. */
  blocker: ServerPowerSaveBlocker;
  /** Log blocker transitions. */
  log?: (...args: unknown[]) => void;
}

/** Keeps application suspension blocked while any server sender is busy. */
export class BusyBlocker {
  private readonly blocker: ServerPowerSaveBlocker;
  private readonly log: (...args: unknown[]) => void;
  private readonly busySenders = new Set<number>();
  private readonly cleanupRegistered = new Set<number>();
  private blockerId: number | null = null;

  constructor(deps: BusyBlockerDeps) {
    this.blocker = deps.blocker;
    this.log = deps.log ?? ((...args) => console.log(...args));
  }

  /** Report a sender's busy state and update the shared suspension blocker. */
  report(sender: ServerBusySender, busy: boolean): void {
    const id = sender.id;
    if (busy) {
      this.busySenders.add(id);
      if (!this.cleanupRegistered.has(id)) {
        this.cleanupRegistered.add(id);
        sender.once("destroyed", () => {
          this.busySenders.delete(id);
          this.cleanupRegistered.delete(id);
          this.update();
        });
      }
    } else {
      this.busySenders.delete(id);
    }
    this.update();
  }

  private update(): void {
    if (this.busySenders.size > 0) {
      if (this.blockerId === null) {
        this.blockerId = this.blocker.start("prevent-app-suspension");
        this.log("[main] Power save blocker started (server busy)");
      }
    } else if (this.blockerId !== null) {
      this.blocker.stop(this.blockerId);
      this.blockerId = null;
      this.log("[main] Power save blocker stopped (server idle)");
    }
  }
}
