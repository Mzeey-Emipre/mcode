/** Backoff delays for backend crash recovery attempts. */
export const SERVER_CRASH_BACKOFF_MS = [1_000, 5_000, 15_000] as const;

/** Time window used to decide whether crashes are part of one crash loop. */
export const SERVER_CRASH_WINDOW_MS = 5 * 60_000;

/** Dependencies required by {@link ServerCrashRecovery}. */
export interface ServerCrashRecoveryDeps {
  /** Restart the backend server. */
  restart: () => Promise<void>;
  /** Surface that the backend crashed and was recovered. */
  notifyRecovered: (code: number | null) => void;
  /** Surface the terminal crash-loop state to the user. */
  showError: (code: number | null) => Promise<void> | void;
  /** Clock injection for deterministic tests. */
  now?: () => number;
  /** Timer injection for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** Handles bounded backend restart attempts after abnormal server exits. */
export class ServerCrashRecovery {
  private readonly restart: () => Promise<void>;
  private readonly notifyRecovered: (code: number | null) => void;
  private readonly showError: (code: number | null) => Promise<void> | void;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private crashTimestamps: number[] = [];
  private inFlight: Promise<void> | null = null;

  constructor(deps: ServerCrashRecoveryDeps) {
    this.restart = deps.restart;
    this.notifyRecovered = deps.notifyRecovered;
    this.showError = deps.showError;
    this.now = deps.now ?? Date.now;
    this.sleep =
      deps.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));
  }

  /** Restart after an unexpected backend exit, or surface a crash loop. */
  handleUnexpectedExit(code: number | null): Promise<void> {
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.recover(code).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async recover(code: number | null): Promise<void> {
    const now = this.now();
    this.crashTimestamps = this.crashTimestamps.filter(
      (timestamp) => now - timestamp < SERVER_CRASH_WINDOW_MS,
    );

    const attemptIndex = this.crashTimestamps.length;
    if (attemptIndex >= SERVER_CRASH_BACKOFF_MS.length) {
      await this.showError(code);
      return;
    }

    this.crashTimestamps.push(now);
    await this.sleep(SERVER_CRASH_BACKOFF_MS[attemptIndex]);

    try {
      await this.restart();
      this.notifyRecovered(code);
    } catch {
      await this.showError(code);
    }
  }
}
