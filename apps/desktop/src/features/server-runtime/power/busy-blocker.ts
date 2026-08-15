interface ServerBusySender {
  readonly id: number;
  once: (event: "destroyed", listener: () => void) => void;
}

interface ServerPowerSaveBlocker {
  start: (reason: "prevent-app-suspension") => number;
  stop: (id: number) => void;
}

interface BusyBlockerDeps {
  blocker: ServerPowerSaveBlocker;
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
