/** One generation-bound Browser host lease. */
export interface BrowserAutomationHostLease {
  readonly hostId: string;
  readonly generation: number;
  readonly desktopInstanceId: string;
  readonly epoch: number;
}

interface BrowserAutomationHostRegistrationResult {
  readonly hostId: string;
  readonly generation: number;
  readonly desktopInstanceId: string;
}

interface BrowserAutomationHostSupervisorOptions {
  readonly register: (epoch: number) => Promise<BrowserAutomationHostRegistrationResult>;
  readonly heartbeat: (lease: BrowserAutomationHostLease) => Promise<void>;
  readonly onLeaseChanged: (lease: BrowserAutomationHostLease | null) => void;
  readonly retryDelayMs: number;
}

/** Owns Browser host registration, heartbeat recovery, and retry serialization. */
export class BrowserAutomationHostSupervisor {
  private lease: BrowserAutomationHostLease | null = null;
  private registration: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private epoch = 0;
  private stopped = true;

  constructor(private readonly options: BrowserAutomationHostSupervisorOptions) {}

  /** Returns the active generation-bound lease, if registration has completed. */
  get currentLease(): BrowserAutomationHostLease | null {
    return this.lease;
  }

  /** Starts registration and resolves after the current attempt settles. */
  start(): Promise<void> {
    this.stopped = false;
    return this.ensureRegistered();
  }

  /** Sends one heartbeat or replaces the lease when the broker rejects it. */
  async pulse(): Promise<void> {
    if (this.stopped) return;
    const lease = this.lease;
    if (!lease) {
      await this.ensureRegistered();
      return;
    }
    try {
      await this.options.heartbeat(lease);
    } catch {
      if (this.stopped || this.lease !== lease) return;
      this.lease = null;
      this.options.onLeaseChanged(null);
      await this.ensureRegistered();
    }
  }

  /** Stops recovery and ignores any registration that completes later. */
  stop(): void {
    this.stopped = true;
    this.epoch += 1;
    this.lease = null;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private ensureRegistered(): Promise<void> {
    if (this.stopped || this.lease) return Promise.resolve();
    if (this.registration) return this.registration;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const epoch = ++this.epoch;
    const registration = this.options.register(epoch)
      .then((result) => {
        if (this.stopped || this.epoch !== epoch) return;
        this.lease = { ...result, epoch };
        this.options.onLeaseChanged(this.lease);
      })
      .catch(() => {
        if (this.stopped || this.epoch !== epoch) return;
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          void this.ensureRegistered();
        }, this.options.retryDelayMs);
      })
      .finally(() => {
        if (this.registration === registration) this.registration = null;
      });
    this.registration = registration;
    return registration;
  }
}
