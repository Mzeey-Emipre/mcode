/** Error raised when queued browser work is cancelled before or during execution. */
export class BrowserAutomationCancelledError extends Error {
  constructor(message = "Browser automation operation was cancelled") {
    super(message);
    this.name = "BrowserAutomationCancelledError";
  }
}

/** Error raised when a bounded browser target queue is full. */
export class BrowserAutomationQueueFullError extends Error {
  constructor() {
    super("Browser automation target queue is full");
    this.name = "BrowserAutomationQueueFullError";
  }
}

interface QueueItem<T> {
  run: (signal: AbortSignal) => Promise<T>;
  controller: AbortController;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

/** Serializes work per browser target while bounding concurrency across all tabs. */
export class BrowserAutomationScheduler {
  private readonly queues = new Map<string, QueueItem<unknown>[]>();
  private readonly runningTargets = new Set<string>();
  private readonly activeItems = new Map<string, QueueItem<unknown>>();
  private activeCount = 0;

  constructor(
    private readonly globalConcurrency = 5,
    private readonly perTargetQueueLimit = 32,
  ) {}

  /** Queues work behind earlier actions for the same target. */
  enqueue<T>(targetKey: string, run: (signal: AbortSignal) => Promise<T>): { promise: Promise<T>; cancel: () => void } {
    const queue = this.queues.get(targetKey) ?? [];
    if (queue.length >= this.perTargetQueueLimit) {
      return {
        promise: Promise.reject(new BrowserAutomationQueueFullError()),
        cancel: () => undefined,
      };
    }
    const controller = new AbortController();
    let item!: QueueItem<T>;
    const promise = new Promise<T>((resolve, reject) => {
      item = { run, controller, resolve, reject };
    });
    queue.push(item as QueueItem<unknown>);
    this.queues.set(targetKey, queue);
    this.pump();
    return {
      promise,
      cancel: () => {
        if (controller.signal.aborted) return;
        const cancellation = new BrowserAutomationCancelledError();
        controller.abort(cancellation);
        const current = this.queues.get(targetKey);
        if (!current || !current.includes(item as QueueItem<unknown>)) return;
        current.splice(current.indexOf(item as QueueItem<unknown>), 1);
        item.reject(cancellation);
        if (current.length === 0) this.queues.delete(targetKey);
      },
    };
  }

  /** Cancels queued and active work for one exact target. */
  cancelTarget(targetKey: string, reason: Error = new BrowserAutomationCancelledError("Browser target changed or closed")): void {
    this.activeItems.get(targetKey)?.controller.abort(reason);
    const queue = this.queues.get(targetKey);
    if (!queue) return;
    for (const item of queue) {
      item.controller.abort(reason);
      item.reject(reason);
    }
    queue.length = 0;
    if (!this.runningTargets.has(targetKey)) this.queues.delete(targetKey);
  }

  /** Returns bounded scheduler counters for status and stress assertions. */
  getCounters(): { active: number; queued: number; targets: number } {
    let queued = 0;
    for (const queue of this.queues.values()) queued += queue.length;
    return { active: this.activeCount, queued, targets: this.queues.size };
  }

  private pump(): void {
    if (this.activeCount >= this.globalConcurrency) return;
    for (const [targetKey, queue] of this.queues) {
      if (this.activeCount >= this.globalConcurrency) break;
      if (this.runningTargets.has(targetKey)) continue;
      const item = queue.shift();
      if (!item) {
        this.queues.delete(targetKey);
        continue;
      }
      if (item.controller.signal.aborted) {
        item.reject(new BrowserAutomationCancelledError());
        continue;
      }
      this.runningTargets.add(targetKey);
      this.activeItems.set(targetKey, item);
      this.activeCount += 1;
      void item
        .run(item.controller.signal)
        .then(item.resolve, item.reject)
        .finally(() => {
          this.runningTargets.delete(targetKey);
          this.activeItems.delete(targetKey);
          this.activeCount -= 1;
          if ((this.queues.get(targetKey)?.length ?? 0) === 0) this.queues.delete(targetKey);
          this.pump();
        });
    }
  }
}
